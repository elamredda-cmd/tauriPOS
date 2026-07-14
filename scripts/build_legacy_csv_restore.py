#!/usr/bin/env python3
"""Build a validated L&Bj POS restore database from legacy CSV exports.

The output starts from a consistent SQLite backup of the live database so sales,
settings, images, and app-only records are preserved. Legacy departments,
products, and customers are then merged into the copy. The live database is
opened read-only and is never modified.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any


PRICE_LIMIT_PENCE = 1_000_000
CATEGORY_COLORS = [
    "#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2",
    "#4f46e5", "#65a30d", "#be123c", "#0d9488", "#7c3aed", "#ca8a04",
]

REQUIRED_HEADERS = {
    "TDEP.csv": {"ID", "description"},
    "TITEM.csv": {
        "DESCRIPTION", "VAT", "DEPID", "PRICE", "BARCODE",
        "STOCK_CURRENT_STOCK_QTY", "PURCHES_PRICE",
    },
    "TCUST.csv": {
        "CUSTID", "NAME", "PCODE", "TNO1", "JOINDATE",
        "LOYALTY_BARCODE", "LOYALTY_POINTS_EARND", "LOYALTY_POINTS_REDEM", "email",
    },
}


def clean(value: Any) -> str:
    return str(value or "").strip()


def meaningful(value: Any) -> str:
    value = clean(value)
    return "" if value in {"", "0"} else value


def decimal_value(value: Any, *, field: str, row_number: int) -> Decimal:
    try:
        return Decimal(clean(value) or "0")
    except InvalidOperation as error:
        raise ValueError(f"Row {row_number}: invalid {field} value {value!r}") from error


def money_pence(value: Any, *, field: str, row_number: int) -> int:
    amount = decimal_value(value, field=field, row_number=row_number) * 100
    return int(amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def integer_value(value: Any, *, field: str, row_number: int) -> int:
    amount = decimal_value(value, field=field, row_number=row_number)
    return int(amount)


def normalized_barcode(value: Any) -> str:
    value = "".join(clean(value).split())
    if not value or set(value) == {"0"}:
        return ""
    return value


def legacy_date(value: Any, fallback: str) -> str:
    raw = clean(value)
    if not raw:
        return fallback
    try:
        parsed = datetime.strptime(raw, "%d/%m/%Y %H:%M:%S").replace(tzinfo=timezone.utc)
        return parsed.isoformat().replace("+00:00", "Z")
    except ValueError:
        return fallback


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", errors="strict", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        rows: list[dict[str, str]] = []
        for row_number, row in enumerate(reader, start=1):
            if None in row:
                raise ValueError(f"{path.name} row {row_number} has more fields than its header")
            rows.append({key: value or "" for key, value in row.items()})

    missing = REQUIRED_HEADERS[path.name] - set(headers)
    if missing:
        raise ValueError(f"{path.name} is missing required columns: {', '.join(sorted(missing))}")
    return headers, rows


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def backup_database(source: Path, output: Path) -> None:
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    output_connection = sqlite3.connect(output)
    try:
        source_connection.backup(output_connection)
    finally:
        output_connection.close()
        source_connection.close()


def row_dict(connection: sqlite3.Connection, table: str, row_id: str) -> dict[str, Any] | None:
    row = connection.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone()
    return dict(row) if row else None


def merge_categories(
    connection: sqlite3.Connection,
    rows: list[dict[str, str]],
    timestamp: str,
) -> tuple[set[str], dict[str, int]]:
    department_ids: set[str] = set()
    stats = Counter()

    for index, row in enumerate(rows, start=1):
        source_id = clean(row["ID"])
        name = clean(row["description"])
        if not source_id or not name:
            stats["skipped"] += 1
            continue

        department_ids.add(source_id)
        category_id = f"old-dep-{source_id}"
        current = row_dict(connection, "categories", category_id)
        if current:
            changed = current["name"] != name or int(current["sortOrder"] or 0) != index or int(current["isActive"] or 0) != 1
            if changed:
                connection.execute(
                    "UPDATE categories SET name = ?, sortOrder = ?, isActive = 1, updatedAt = ? WHERE id = ?",
                    (name, index, timestamp, category_id),
                )
                stats["updated"] += 1
            else:
                stats["unchanged"] += 1
        else:
            connection.execute(
                "INSERT INTO categories (id, name, color, sortOrder, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?)",
                (category_id, name, CATEGORY_COLORS[(index - 1) % len(CATEGORY_COLORS)], index, timestamp, timestamp),
            )
            stats["inserted"] += 1

    fallback_id = "old-dep-uncategorised"
    if not row_dict(connection, "categories", fallback_id):
        connection.execute(
            "INSERT INTO categories (id, name, color, sortOrder, isActive, createdAt, updatedAt) VALUES (?, 'Uncategorised', '#64748b', ?, 1, ?, ?)",
            (fallback_id, len(rows) + 1, timestamp, timestamp),
        )
        stats["inserted"] += 1

    return department_ids, dict(stats)


def merge_products(
    connection: sqlite3.Connection,
    rows: list[dict[str, str]],
    department_ids: set[str],
    timestamp: str,
) -> tuple[dict[str, int], list[dict[str, Any]], list[dict[str, Any]]]:
    stats = Counter()
    seen_barcodes: set[str] = set()
    skipped: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []

    for row_number, row in enumerate(rows, start=1):
        name = clean(row["DESCRIPTION"])
        price = money_pence(row["PRICE"], field="PRICE", row_number=row_number)
        cost_price = money_pence(row["PURCHES_PRICE"], field="PURCHES_PRICE", row_number=row_number)

        reasons: list[str] = []
        if not name:
            reasons.append("missing name")
        if price < 0 or price > PRICE_LIMIT_PENCE:
            reasons.append(f"price outside £0-£10,000 range ({price}p)")
        if cost_price < 0 or cost_price > PRICE_LIMIT_PENCE:
            reasons.append(f"cost price outside £0-£10,000 range ({cost_price}p)")
        if reasons:
            skipped.append({"row": row_number, "name": name, "reasons": reasons})
            stats["skipped"] += 1
            continue

        barcode = normalized_barcode(row["BARCODE"])
        if barcode and barcode in seen_barcodes:
            barcode = ""
            stats["duplicate_barcodes_blanked"] += 1
        elif barcode:
            seen_barcodes.add(barcode)

        department_id = clean(row["DEPID"])
        if department_id in department_ids:
            category_id = f"old-dep-{department_id}"
        else:
            category_id = "old-dep-uncategorised"
            stats["uncategorised"] += 1

        tax_rate_id = "tax-standard-vat" if clean(row["VAT"]) == "A" else "tax-zero"
        stock_level = integer_value(
            row["STOCK_CURRENT_STOCK_QTY"],
            field="STOCK_CURRENT_STOCK_QTY",
            row_number=row_number,
        )
        track_stock = int(stock_level != 0)
        product_id = f"old-item-{row_number:06d}"
        current = row_dict(connection, "products", product_id)

        source_values = {
            "name": name,
            "categoryId": category_id,
            "taxRateId": tax_rate_id,
            "barcode": barcode,
            "price": price,
            "costPrice": cost_price,
            "stockLevel": stock_level,
            "trackStock": track_stock,
        }

        if current:
            changed_fields = {
                field: {"from": current[field] if current[field] is not None else "", "to": value}
                for field, value in source_values.items()
                if (current[field] if current[field] is not None else "") != value
            }
            if changed_fields:
                connection.execute(
                    """
                    UPDATE products
                    SET name = ?, categoryId = ?, taxRateId = ?, barcode = ?, price = ?,
                        costPrice = ?, stockLevel = ?, trackStock = ?, updatedAt = ?
                    WHERE id = ?
                    """,
                    (
                        name, category_id, tax_rate_id, barcode, price,
                        cost_price, stock_level, track_stock, timestamp, product_id,
                    ),
                )
                changes.append({"id": product_id, "name": name, "fields": changed_fields})
                stats["updated"] += 1
            else:
                stats["unchanged"] += 1
        else:
            color_row = connection.execute("SELECT color FROM categories WHERE id = ?", (category_id,)).fetchone()
            color = color_row[0] if color_row else "#64748b"
            connection.execute(
                """
                INSERT INTO products (
                    id, categoryId, taxRateId, name, sku, barcode, scalePlu,
                    price, costPrice, stockLevel, trackStock, allowPriceOverride,
                    isWeighable, showInGoods, goodsSortOrder, color, image,
                    isActive, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, '', ?, '', ?, ?, ?, ?, 0, 0, 0, 0, ?, '', 1, ?, ?)
                """,
                (
                    product_id, category_id, tax_rate_id, name, barcode, price,
                    cost_price, stock_level, track_stock, color, timestamp, timestamp,
                ),
            )
            stats["inserted"] += 1

    return dict(stats), skipped, changes


def merge_customers_and_reset_points(
    connection: sqlite3.Connection,
    rows: list[dict[str, str]],
    timestamp: str,
) -> dict[str, int]:
    stats = Counter()

    for row_number, row in enumerate(rows, start=1):
        source_id = clean(row["CUSTID"])
        if not source_id:
            stats["skipped"] += 1
            continue

        customer_id = f"old-cust-{source_id}"
        current = row_dict(connection, "customers", customer_id)
        source_name = meaningful(row["NAME"])
        name = source_name or (clean(current["name"]) if current else "") or f"Customer {source_id}"
        phone = meaningful(row["TNO1"]) or (clean(current["phone"]) if current else "")
        email = meaningful(row["email"]) or (clean(current["email"]) if current else "")
        postcode = meaningful(row["PCODE"]) or (clean(current["postcode"]) if current else "")
        loyalty_code = meaningful(row["LOYALTY_BARCODE"]) or (clean(current["loyaltyCode"]) if current else "")

        if current:
            changed = any([
                clean(current["name"]) != name,
                clean(current["phone"]) != phone,
                clean(current["email"]) != email,
                clean(current["postcode"]) != postcode,
                clean(current["loyaltyCode"]) != loyalty_code,
            ])
            if changed:
                connection.execute(
                    """
                    UPDATE customers
                    SET name = ?, phone = ?, email = ?, postcode = ?, loyaltyCode = ?, updatedAt = ?
                    WHERE id = ?
                    """,
                    (name, phone, email, postcode, loyalty_code, timestamp, customer_id),
                )
                stats["updated"] += 1
            else:
                stats["unchanged"] += 1
        else:
            created_at = legacy_date(row["JOINDATE"], timestamp)
            connection.execute(
                """
                INSERT INTO customers (
                    id, name, phone, email, postcode, loyaltyCode,
                    loyaltyPoints, notes, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, ?)
                """,
                (customer_id, name, phone, email, postcode, loyalty_code, created_at, timestamp),
            )
            stats["inserted"] += 1

    points_before = connection.execute(
        "SELECT COUNT(*), COALESCE(SUM(loyaltyPoints), 0) FROM customers WHERE loyaltyPoints <> 0"
    ).fetchone()
    connection.execute(
        "UPDATE customers SET loyaltyPoints = 0, updatedAt = ? WHERE loyaltyPoints <> 0",
        (timestamp,),
    )
    stats["balances_reset"] = int(points_before[0])
    stats["points_removed"] = int(points_before[1])
    return dict(stats)


def duplicate_count(connection: sqlite3.Connection, column: str) -> int:
    row = connection.execute(
        f"""
        SELECT COUNT(*) FROM (
            SELECT {column} FROM products
            WHERE {column} IS NOT NULL AND TRIM({column}) <> ''
            GROUP BY {column} HAVING COUNT(*) > 1
        )
        """
    ).fetchone()
    return int(row[0])


def validate_output(connection: sqlite3.Connection) -> dict[str, Any]:
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    foreign_keys = [list(row) for row in connection.execute("PRAGMA foreign_key_check")]
    counts = {
        table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in ("categories", "products", "customers", "orders", "order_lines", "product_images")
    }
    impossible_prices = int(connection.execute(
        """
        SELECT COUNT(*) FROM products
        WHERE id IS NULL OR TRIM(id) = '' OR name IS NULL OR TRIM(name) = ''
           OR price IS NULL OR price < 0 OR price > ?
           OR COALESCE(costPrice, 0) < 0 OR COALESCE(costPrice, 0) > ?
        """,
        (PRICE_LIMIT_PENCE, PRICE_LIMIT_PENCE),
    ).fetchone()[0])
    customers_with_points = int(connection.execute(
        "SELECT COUNT(*) FROM customers WHERE COALESCE(loyaltyPoints, 0) <> 0"
    ).fetchone()[0])

    return {
        "integrity_check": integrity,
        "foreign_key_issues": foreign_keys,
        "counts": counts,
        "impossible_product_rows": impossible_prices,
        "duplicate_product_values": {
            column: duplicate_count(connection, column)
            for column in ("barcode", "sku", "scalePlu")
        },
        "customers_with_nonzero_points": customers_with_points,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv-dir", type=Path, required=True)
    parser.add_argument("--source-db", type=Path, required=True)
    parser.add_argument("--output-db", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    csv_dir = args.csv_dir.expanduser().resolve()
    source_db = args.source_db.expanduser().resolve()
    output_db = args.output_db.expanduser().resolve()
    report_path = (args.report or output_db.with_suffix(".validation.json")).expanduser().resolve()

    source_hash_before = file_sha256(source_db)
    department_headers, departments = read_csv(csv_dir / "TDEP.csv")
    product_headers, products = read_csv(csv_dir / "TITEM.csv")
    customer_headers, customers = read_csv(csv_dir / "TCUST.csv")

    backup_database(source_db, output_db)
    connection = sqlite3.connect(output_db)
    connection.row_factory = sqlite3.Row
    timestamp = utc_now()
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN IMMEDIATE")
        department_ids, category_stats = merge_categories(connection, departments, timestamp)
        product_stats, skipped_products, product_changes = merge_products(
            connection, products, department_ids, timestamp
        )
        customer_stats = merge_customers_and_reset_points(connection, customers, timestamp)
        connection.commit()
        validation = validate_output(connection)
    except Exception:
        connection.rollback()
        connection.close()
        output_db.unlink(missing_ok=True)
        raise
    finally:
        if connection:
            connection.close()

    source_hash_after = file_sha256(source_db)
    if source_hash_before != source_hash_after:
        output_db.unlink(missing_ok=True)
        raise RuntimeError("The live source database changed unexpectedly during the build")

    duplicate_department_names = sum(
        count - 1 for count in Counter(clean(row["description"]) for row in departments).values() if count > 1
    )
    report = {
        "created_at": timestamp,
        "mode": "safe merge into a consistent copy; live database untouched",
        "source": {
            "database": str(source_db),
            "database_sha256": source_hash_before,
            "csv_directory": str(csv_dir),
            "rows": {
                "departments": len(departments),
                "products": len(products),
                "customers": len(customers),
            },
            "column_counts": {
                "departments": len(department_headers),
                "products": len(product_headers),
                "customers": len(customer_headers),
            },
            "duplicate_department_names": duplicate_department_names,
        },
        "merge": {
            "categories": category_stats,
            "products": product_stats,
            "customers": customer_stats,
            "skipped_products": skipped_products,
            "product_changes": product_changes,
        },
        "preserved": [
            "sales and orders",
            "settings and till configuration",
            "product images and product UI options",
            "manually added products and customers",
            "all other app tables",
        ],
        "validation": validation,
        "output": {
            "database": str(output_db),
            "database_sha256": file_sha256(output_db),
            "size_bytes": output_db.stat().st_size,
        },
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
