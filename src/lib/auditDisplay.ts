export interface AuditDisplayRecord {
    action: string;
    entityType: string;
    entityId: string;
    oldData: string;
    newData: string;
}

export interface AuditFieldChange {
    key: string;
    label: string;
    before: string;
    after: string;
    kind: 'added' | 'removed' | 'changed';
}

export type AuditReferenceResolver = (kind: string, value: string) => string | undefined;

interface FlatAuditValue {
    label: string;
    value: string;
}

const ACTION_LABELS: Record<string, string> = {
    cash_drawer_opened: 'Cash drawer opened',
    employee_login: 'Staff signed in',
    employee_logout: 'Staff signed out',
    manager_approval_granted: 'Manager approval granted',
    order_partially_refunded: 'Partial refund completed',
    order_refunded: 'Refund completed',
    order_voided: 'Order voided',
    product_deactivated: 'Item deactivated',
    products_imported: 'Items imported',
    promotion_created: 'Promotion created',
    promotion_deleted: 'Promotion deleted',
    promotion_updated: 'Promotion updated',
    report_period_closed: 'End-of-day report closed',
    sale_completed: 'Sale completed',
    stock_adjusted: 'Stock adjusted',
    stock_counted: 'Stock count saved',
};

const ENTITY_LABELS: Record<string, string> = {
    cash_drawer: 'Cash drawer',
    cash_movement: 'Cash movement',
    category: 'Category',
    customer: 'Customer',
    discount: 'Discount',
    employee: 'Staff member',
    order: 'Order',
    pos_page: 'POS page',
    pos_tile: 'POS tile',
    product: 'Item',
    product_supplier: 'Item supplier',
    promotion: 'Promotion',
    promotion_group: 'Promotion group',
    promotion_item: 'Promotion item',
    report: 'Report',
    setting: 'Setting',
    shift: 'Till session',
    stock_receipt: 'Stock delivery',
    stock_receipt_line: 'Stock delivery item',
    supplier: 'Supplier',
    tax_rate: 'Tax rate',
    till: 'Till',
};

const FIELD_LABELS: Record<string, string> = {
    action: 'Action',
    actualCard: 'Actual card total',
    actualCash: 'Actual cash total',
    address: 'Address',
    amount: 'Amount',
    amountTendered: 'Amount tendered',
    autoApply: 'Applied automatically',
    barcode: 'Barcode',
    bundlePrice: 'Bundle price',
    bundleQuantity: 'Bundle quantity',
    cardAmount: 'Card amount',
    cardDifference: 'Card difference',
    cashAmount: 'Cash amount',
    cashDifference: 'Cash difference',
    categoryId: 'Category',
    changeGiven: 'Change given',
    closedAt: 'Closed at',
    closedByEmployeeId: 'Closed by',
    color: 'Colour',
    contactName: 'Contact name',
    costPrice: 'Cost price',
    customerId: 'Customer',
    customerName: 'Customer',
    discountAmount: 'Discount',
    email: 'Email',
    employeeId: 'Staff member',
    endAt: 'Ends',
    expectedCard: 'Expected card total',
    expectedCash: 'Expected cash total',
    expectedStockLevel: 'Expected stock',
    groupId: 'Promotion group',
    isActive: 'Active',
    isDefault: 'Default tax rate',
    isPriceOverride: 'Price changed at till',
    isWeighable: 'Weighed item',
    itemLines: 'Different items',
    itemQuantity: 'Total quantity',
    kind: 'Promotion type',
    loyaltyCode: 'Loyalty code',
    loyaltyCreditUsed: 'Loyalty credit used',
    loyaltyPoints: 'Loyalty points',
    loyaltyPointsEarned: 'Points earned',
    loyaltyPointsRedeemed: 'Points redeemed',
    maxApplications: 'Maximum uses per sale',
    minQuantity: 'Minimum quantity',
    name: 'Name',
    notes: 'Notes',
    openedAt: 'Opened at',
    openingFloat: 'Opening float',
    orderId: 'Order',
    orderNumber: 'Receipt number',
    originalOrderId: 'Original order',
    originalPrice: 'Original price',
    pageId: 'POS page',
    paymentMethod: 'Payment method',
    phone: 'Phone',
    pointsChange: 'Points change',
    position: 'Position',
    postcode: 'Postcode',
    price: 'Selling price',
    priority: 'Priority',
    productId: 'Item',
    productName: 'Item',
    quantity: 'Quantity',
    rate: 'Tax rate',
    reason: 'Reason',
    refundAmount: 'Refund amount',
    registerId: 'Till',
    reportTotal: 'Report total',
    reversalId: 'Refund record',
    role: 'Role',
    scalePlu: 'Scale PLU',
    scope: 'Report scope',
    secondPrice: 'Offer price',
    sku: 'SKU',
    startAt: 'Starts',
    status: 'Status',
    stockLevel: 'Stock level',
    subtotal: 'Subtotal',
    taxAmount: 'Tax amount',
    taxRate: 'Tax rate',
    taxRateId: 'Tax rate',
    taxTotal: 'Tax total',
    tillName: 'Till',
    tillNumber: 'Till',
    total: 'Total',
    trackStock: 'Track stock',
    type: 'Type',
    unitPrice: 'Unit price',
    value: 'Value',
};

const SETTING_LABELS: Record<string, string> = {
    cctv_pos_enabled: 'CCTV overlay',
    feedback_button_sound_enabled: 'Button sound',
    feedback_haptics_enabled: 'Button vibration',
    feedback_scan_sound_enabled: 'Scan sound',
    feedback_sound_enabled: 'App sound',
    loyalty_enabled: 'Customer loyalty',
    role_permissions: 'Staff role permissions',
    stock_tracking_enabled: 'Stock tracking',
    store_info: 'Shop information',
    training_mode_enabled: 'Training mode',
};

const MONEY_FIELDS = new Set([
    'actualCard', 'actualCash', 'amount', 'amountTendered', 'bundlePrice',
    'cardAmount', 'cardDifference', 'cashAmount', 'cashDifference', 'changeGiven',
    'costPrice', 'discountAmount', 'expectedCard', 'expectedCash', 'lineTotal',
    'loyaltyCreditUsed', 'openingFloat', 'originalPrice', 'price', 'refundAmount',
    'reportTotal', 'secondPrice', 'subtotal', 'taxAmount', 'taxTotal', 'total',
    'unitPrice',
]);

const BOOLEAN_FIELDS = new Set([
    'autoApply', 'isActive', 'isDefault', 'isPriceOverride', 'isWeighable',
    'showInGoods', 'trackStock',
]);

const REFERENCE_KINDS: Record<string, string> = {
    approvedByEmployeeId: 'employee',
    categoryId: 'category',
    closedByEmployeeId: 'employee',
    customerId: 'customer',
    employeeId: 'employee',
    groupId: 'promotion_group',
    orderId: 'order',
    originalOrderId: 'order',
    pageId: 'pos_page',
    productId: 'product',
    registerId: 'till',
    requestedByEmployeeId: 'employee',
    reversalId: 'order',
    taxRateId: 'tax_rate',
    tillNumber: 'till',
};

const HIDDEN_FIELDS = new Set([
    'createdAt', 'id', 'pin', 'pinHash', 'receiptKey', 'storeId', 'updatedAt',
]);

function titleWords(value: string): string {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => {
            const upper = word.toUpperCase();
            if (['API', 'CCTV', 'ID', 'IP', 'PLU', 'POS', 'SKU', 'USB', 'VAT'].includes(upper)) return upper;
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
}

export function auditActionLabel(action: string): string {
    if (ACTION_LABELS[action]) return ACTION_LABELS[action];
    const recordChange = String(action || '').match(/^(.+)_(created|updated|deleted|deactivated)$/);
    if (recordChange) return `${auditEntityLabel(recordChange[1])} ${recordChange[2]}`;
    const words = titleWords(action || 'Activity');
    return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : 'Activity';
}

export function auditEntityLabel(entityType: string): string {
    return ENTITY_LABELS[entityType] || titleWords(entityType || 'Record');
}

export function auditSettingLabel(key: string): string {
    if (SETTING_LABELS[key]) return SETTING_LABELS[key];
    return titleWords(key).replace(/ Enabled$/i, '');
}

export function shortAuditReference(value: string): string {
    const text = String(value || '').trim();
    if (!text) return 'No reference';
    if (text.length <= 18) return text;
    return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

export function parseAuditJson(value: string): any {
    if (!value) return null;
    try { return JSON.parse(value); }
    catch { return value; }
}

export function prettyAuditJson(value: string): string {
    if (!value) return '';
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
}

function isSensitiveField(key: string): boolean {
    const lower = key.toLowerCase();
    return lower.includes('pin')
        || lower.includes('password')
        || lower.includes('secret')
        || lower.includes('token')
        || lower.includes('hash');
}

function isEmptyValue(value: unknown): boolean {
    return value === null || value === undefined || value === '';
}

function formatMoney(value: unknown): string {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return String(value ?? '');
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount / 100);
}

function booleanValue(value: unknown): boolean | null {
    if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
    if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
    return null;
}

function formatDate(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    });
}

function formatSettingValue(key: string, value: unknown): string {
    const bool = booleanValue(value);
    if (bool !== null && /(enabled|active|tracking|require|show|auto)/i.test(key)) {
        return bool ? 'On' : 'Off';
    }
    return formatScalar(key, value, undefined, undefined);
}

function formatScalar(
    key: string,
    value: unknown,
    parent: Record<string, any> | undefined,
    resolveReference: AuditReferenceResolver | undefined,
): string {
    if (isEmptyValue(value)) return 'Not set';
    if (value === '[redacted]') return 'Protected';
    if (typeof value === 'string' && /^\[image data/i.test(value)) return 'Image stored';

    const referenceKind = REFERENCE_KINDS[key];
    if (referenceKind && typeof value === 'string') {
        return resolveReference?.(referenceKind, value) || shortAuditReference(value);
    }
    if (MONEY_FIELDS.has(key)) return formatMoney(value);
    if (key === 'value' && parent?.type === 'fixed') return formatMoney(value);
    if (key === 'value' && parent?.type === 'percentage') return `${Number(value) || 0}%`;
    if (key === 'rate' || key === 'taxRate') {
        const rate = Number(value);
        if (Number.isFinite(rate)) return `${Math.abs(rate) <= 1 ? rate * 100 : rate}%`;
    }
    if (BOOLEAN_FIELDS.has(key)) {
        const bool = booleanValue(value);
        if (bool !== null) return bool ? 'Yes' : 'No';
    }
    if (key.endsWith('At') || key === 'periodStart' || key === 'periodEnd') {
        const date = formatDate(value);
        if (date) return date;
    }
    if (['action', 'kind', 'paymentMethod', 'reason', 'role', 'scope', 'status', 'type'].includes(key)) {
        return titleWords(String(value).replace(/\+/g, ' + '));
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return value.toLocaleString('en-GB');
    return String(value);
}

function fieldLabel(key: string): string {
    return FIELD_LABELS[key] || titleWords(key);
}

function singularLabel(label: string): string {
    if (/ies$/i.test(label)) return label.replace(/ies$/i, 'y');
    if (/s$/i.test(label)) return label.slice(0, -1);
    return label;
}

function flattenValue(
    value: any,
    keyPath: string[],
    labelPath: string[],
    result: Map<string, FlatAuditValue>,
    resolveReference?: AuditReferenceResolver,
    parent?: Record<string, any>,
) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            const itemName = item && typeof item === 'object' ? String(item.name || '').trim() : '';
            const baseLabel = singularLabel(labelPath[labelPath.length - 1] || 'Item');
            flattenValue(
                item,
                [...keyPath, String(index)],
                [...labelPath.slice(0, -1), itemName || `${baseLabel} ${index + 1}`],
                result,
                resolveReference,
                item && typeof item === 'object' ? item : undefined,
            );
        });
        return;
    }

    if (value && typeof value === 'object') {
        for (const [childKey, childValue] of Object.entries(value)) {
            if (HIDDEN_FIELDS.has(childKey) || isSensitiveField(childKey)) continue;
            flattenValue(
                childValue,
                [...keyPath, childKey],
                [...labelPath, fieldLabel(childKey)],
                result,
                resolveReference,
                value,
            );
        }
        return;
    }

    if (isEmptyValue(value)) return;
    const key = keyPath[keyPath.length - 1] || 'value';
    const path = keyPath.join('.');
    result.set(path, {
        label: labelPath.join(' · ') || fieldLabel(key),
        value: formatScalar(key, value, parent, resolveReference),
    });
}

function flattenAuditData(
    data: any,
    entityType: string,
    resolveReference?: AuditReferenceResolver,
): Map<string, FlatAuditValue> {
    const result = new Map<string, FlatAuditValue>();
    if (!data || typeof data !== 'object') {
        if (!isEmptyValue(data)) result.set('value', { label: 'Value', value: String(data) });
        return result;
    }

    if (entityType === 'setting' && typeof data.key === 'string' && 'value' in data) {
        const settingKey = data.key;
        const nestedValue = typeof data.value === 'string' ? parseAuditJson(data.value) : data.value;
        if (nestedValue && typeof nestedValue === 'object') {
            flattenValue(
                nestedValue,
                [`setting:${settingKey}`],
                [auditSettingLabel(settingKey)],
                result,
                resolveReference,
            );
        } else if (!isEmptyValue(nestedValue)) {
            result.set(`setting:${settingKey}`, {
                label: auditSettingLabel(settingKey),
                value: formatSettingValue(settingKey, nestedValue),
            });
        }
        return result;
    }

    flattenValue(data, [], [], result, resolveReference, data);
    return result;
}

export function buildAuditChanges(
    record: AuditDisplayRecord,
    resolveReference?: AuditReferenceResolver,
): AuditFieldChange[] {
    const before = flattenAuditData(parseAuditJson(record.oldData), record.entityType, resolveReference);
    const after = flattenAuditData(parseAuditJson(record.newData), record.entityType, resolveReference);
    const keys = new Set([...before.keys(), ...after.keys()]);
    const changes: AuditFieldChange[] = [];

    for (const key of keys) {
        const previous = before.get(key);
        const next = after.get(key);
        if (previous?.value === next?.value) continue;
        changes.push({
            key,
            label: next?.label || previous?.label || 'Value',
            before: previous?.value || '',
            after: next?.value || '',
            kind: previous && next ? 'changed' : next ? 'added' : 'removed',
        });
    }

    return changes.sort((left, right) => left.label.localeCompare(right.label, 'en-GB'));
}

function candidateName(value: any): string {
    if (!value || typeof value !== 'object') return '';
    if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
    if (typeof value.customerName === 'string' && value.customerName.trim()) return value.customerName.trim();
    if (typeof value.productName === 'string' && value.productName.trim()) return value.productName.trim();
    if (typeof value.tillName === 'string' && value.tillName.trim()) return value.tillName.trim();
    if (value.group) {
        const groupName = candidateName(value.group);
        if (groupName) return groupName;
    }
    if (Array.isArray(value.discounts) && value.discounts.length > 0) {
        const discountName = candidateName(value.discounts[0]);
        if (discountName) return discountName;
    }
    return '';
}

export function auditRecordName(record: AuditDisplayRecord): string {
    if (record.entityType === 'setting') {
        const data = parseAuditJson(record.newData) || parseAuditJson(record.oldData);
        if (data && typeof data.key === 'string') return auditSettingLabel(data.key);
    }
    return candidateName(parseAuditJson(record.newData))
        || candidateName(parseAuditJson(record.oldData));
}
