# Shop POS

This Tauri POS supports:

- Local mode: one till using its own SQLite database.
- Multi-till mode: each till keeps an offline SQLite cache and synchronizes with a shared MariaDB server.

## MariaDB Setup

Do not connect tills using MariaDB's `root` account. Create a dedicated account:

```sql
CREATE DATABASE pos_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pos_app'@'%' IDENTIFIED BY 'replace-with-a-long-random-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
ON pos_db.* TO 'pos_app'@'%';
FLUSH PRIVILEGES;
```

Restrict MariaDB and the host firewall to the shop's trusted local network. The app stores the MariaDB connection configuration, including its password, in the till's local SQLite settings database. Protect the till account and backups accordingly.

## Safe Local-to-Multi Migration

1. Create a backup in **Settings > Backup and Restore**.
2. Connect the till to an empty MariaDB `pos_db` database.
3. Run **Validate Database Schemas**.
4. Run **Migrate Local Data to Multi-Till**.
5. Connect additional tills normally. They download the shared shop data.

The migration refuses to overwrite a MariaDB database that already contains products, orders, or customers.

## Two-Till Development Simulation

The repository includes isolated till profiles:

```bash
npm run tauri:till1
npm run tauri:till2
```

Each profile has a separate local SQLite cache and application identity while both can connect to the same MariaDB server.
