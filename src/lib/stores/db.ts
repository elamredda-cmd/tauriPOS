import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';

// ─────────────────────────────────────────────
// UTILITY: UUID generator
// ─────────────────────────────────────────────
export function uuid(): string {
    return crypto.randomUUID();
}

export function now(): string {
    return new Date().toISOString();
}

/** Convert pounds to pence: £2.50 → 250 */
export function toPence(pounds: number): number {
    return Math.round(pounds * 100);
}

/** Convert pence to pounds: 250 → 2.50 */
export function toPounds(pence: number): number {
    return pence / 100;
}

/** Format pence as £ string: 250 → "£2.50" */
export function formatMoney(pence: number): string {
    return `£${(pence / 100).toFixed(2)}`;
}

// ─────────────────────────────────────────────
// INTERFACES — All 19 tables
// ─────────────────────────────────────────────

// 1. Store
export interface Store {
    id: string;
    name: string;
    address: string;
    phone: string;
    email: string;
    currency: string;
    taxIncludedInPrice: boolean;
    receiptHeader: string;
    receiptFooter: string;
    createdAt: string;
}

// 2. Register
export interface Register {
    id: string;
    storeId: string;
    name: string;
    isActive: boolean;
    createdAt: string;
    updatedAt?: string;
}

// 3. Employee
export interface Employee {
    id: string;
    storeId: string;
    name: string;
    pin: string;
    pinHash?: string;
    role: 'admin' | 'manager' | 'supervisor' | 'cashier';
    email: string;
    isActive: boolean;
    createdAt: string;
    updatedAt?: string;
    isSupportSession?: boolean;
    supportSessionId?: string;
    supportExpiresAt?: string;
}

// 4. Customer
export interface Customer {
    id: string;
    name: string;
    phone: string;
    email: string;
    postcode: string;
    loyaltyCode: string;
    loyaltyPoints: number;
    notes: string;
    createdAt: string;
    updatedAt: string;
}

// 5. Category
export interface Category {
    id: string;
    name: string;
    color: string;
    sortOrder: number;
    isActive: boolean;
    createdAt: string;
}

// 6. TaxRate
export interface TaxRate {
    id: string;
    name: string;
    rate: number;      // e.g. 0.20 for 20%
    isDefault: boolean;
    createdAt: string;
}

// 7. Product
export interface Product {
    id: string;
    categoryId: string;
    taxRateId: string;
    name: string;
    sku: string;
    barcode: string;
    scalePlu?: string;
    price: number;           // pence
    costPrice: number;       // pence
    stockLevel: number;
    trackStock: boolean;
    allowPriceOverride?: boolean;
    isWeighable: boolean;
    showInGoods: boolean;
    goodsSortOrder: number;
    color: string;
    image: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}

// 8. Supplier
export interface Supplier {
    id: string;
    name: string;
    contactName: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
    createdAt: string;
}

// 9. ProductSupplier (bridge)
export interface ProductSupplier {
    id: string;
    productId: string;
    supplierId: string;
    supplierSku: string;
    costPrice: number;       // pence
    isPreferred: boolean;
}

// 10. InventoryLog
export interface InventoryLog {
    id: string;
    productId: string;
    quantityChange: number;
    type: 'sale' | 'return' | 'restock' | 'adjustment' | 'waste';
    referenceId: string;
    employeeId: string;
    notes: string;
    createdAt: string;
}

// 11. Shift
export interface Shift {
    id: string;
    registerId: string;
    employeeId: string;
    closedByEmployeeId: string;
    openedAt: string;
    closedAt: string;
    openingFloat: number;    // pence
    expectedCash: number;    // pence
    actualCash: number;      // pence
    cashDifference: number;  // pence
    expectedCard: number;    // pence
    actualCard: number;      // pence
    cardDifference: number;  // pence
    status: 'open' | 'closed';
    notes: string;
    updatedAt: string;
}

// 12. CashMovement
export interface CashMovement {
    id: string;
    shiftId: string;
    employeeId: string;
    amount: number;          // pence, +in / -out
    reason: string;
    createdAt: string;
}

// 13. Discount
export type DiscountKind =
    | 'manual_percent'      // cashier picks; % off a line / ticket
    | 'manual_amount'       // cashier picks; pence off a ticket
    | 'bogo_fixed_price'    // auto: every (minQuantity+1)th unit in the group is sold at secondPrice
    | 'bundle_fixed_price'  // auto: any `bundleQuantity` units from the group total `bundlePrice`
    | 'temporary_item';     // auto: temporary percentage off or sale price for one item

export interface Discount {
    id: string;
    name: string;
    type: 'percentage' | 'fixed';   // legacy; kept for back-compat with manual_percent / manual_amount
    value: number;                  // percentage number OR pence if fixed
    isActive: boolean;
    createdAt: string;
    kind: DiscountKind;
    autoApply: boolean;             // true for BOGO/bundle, false for manual_*
    groupId: string;                // FK promo_groups.id (BOGO/bundle only)
    minQuantity: number;            // BOGO: full-priced units before the deal kicks in (typically 1)
    secondPrice: number;            // BOGO: pence price applied to the (N+1)th unit
    bundleQuantity: number;         // Bundle: how many units form one bundle
    bundlePrice: number;            // Bundle: total pence for one bundle
    maxApplications: number | null; // null = unlimited per cart
    startAt: string;                // ISO datetime; '' = always
    endAt: string;                  // ISO datetime; '' = always
    priority: number;               // higher wins ties when 'best for customer' is equal
    updatedAt?: string;
}

// 13b. Promo Group — a named pool of products that BOGO/bundle promos reference
export interface PromoGroup {
    id: string;
    name: string;
    startAt: string;       // ISO datetime; '' = always
    endAt: string;         // ISO datetime; '' = always
    isActive: boolean;
    createdAt: string;
    updatedAt?: string;
}

export interface PromoGroupItem {
    id: string;
    groupId: string;
    productId: string;
    updatedAt?: string;
}

// 14. Order
export interface Order {
    id: string;
    shiftId: string;
    customerId: string;
    employeeId: string;
    orderNumber: number;
    receiptKey?: string;
    type: 'sale' | 'return' | 'exchange';
    status: 'hold' | 'open' | 'completed' | 'voided' | 'returned' | 'refunded' | 'partially_refunded';
    originalOrderId: string;
    subtotal: number;        // pence
    discountId: string;
    discountAmount: number;  // pence
    taxTotal: number;        // pence
    total: number;           // pence
    tillNumber: string;      // identifies which till processed this order
    notes: string;
    paymentMethod: string;
    amountTendered: number;
    createdAt: string;
    completedAt: string;
    updatedAt: string;
}

// 15. OrderLine
export interface OrderLine {
    id: string;
    orderId: string;
    productId: string;
    productName: string;     // snapshot
    quantity: number;
    unitPrice: number;       // pence (snapshot)
    costPrice: number;       // pence (snapshot)
    discountId: string;
    discountAmount: number;  // pence
    taxRate: number;         // snapshot e.g. 0.20
    taxAmount: number;       // pence
    lineTotal: number;       // pence
    isPriceOverride: boolean;
    originalPrice: number;   // pence
    notes: string;
    updatedAt: string;
}

// 16. Payment
export interface Payment {
    id: string;
    orderId: string;
    method: 'cash' | 'card' | 'split' | 'mobile' | 'gift_card' | 'store_credit' | 'loyalty';
    amount: number;          // pence (total sale amount)
    cashAmount: number;      // pence (cash tendered)
    cardAmount: number;      // pence (card portion)
    reference: string;
    changeGiven: number;     // pence
    createdAt: string;
    updatedAt: string;
}

// 17. LoyaltyLog
export interface LoyaltyLog {
    id: string;
    customerId: string;
    orderId: string;
    pointsChange: number;
    reason: 'earned' | 'redeemed' | 'manual_adjustment' | 'refund_adjustment';
    createdAt: string;
    updatedAt: string;
}

// 18. AuditLog
export interface AuditLog {
    id: string;
    employeeId: string;
    action: string;
    entityType: string;
    entityId: string;
    oldData: string;         // JSON string
    newData: string;         // JSON string
    createdAt: string;
}

// 19. Setting
export interface Setting {
    key: string;
    value: string;
    updatedAt: string;
}

export interface TillReportMarker {
    id: string;
    tillNumber: string;
    type: string;
    markerTime: string;
    periodStart: string;
    periodEnd: string;
    employeeId: string;
    reportText: string;
    reportTotal: number;
    createdAt: string;
    updatedAt: string;
}

export interface ManagerApproval {
    id: string;
    requestedByEmployeeId: string;
    approvedByEmployeeId: string;
    action: string;
    entityType: string;
    entityId: string;
    notes: string;
    createdAt: string;
    updatedAt: string;
}

export interface StockReceipt {
    id: string;
    supplierId: string;
    employeeId: string;
    reference: string;
    notes: string;
    totalCost: number;
    status: 'received' | 'voided';
    createdAt: string;
    updatedAt: string;
}

export interface StockReceiptLine {
    id: string;
    receiptId: string;
    productId: string;
    quantity: number;
    unitCost: number;
    createdAt: string;
    updatedAt: string;
}


// ─────────────────────────────────────────────
// STORES — Transitioning to SQLite
// ─────────────────────────────────────────────
// We no longer use LocalStorage. Stores are initialized with seed data 
// and will be synchronized with SQLite in +layout.svelte.


// ─────────────────────────────────────────────
// SEED DATA
// ─────────────────────────────────────────────

const STORE_ID = 'store-luton-pool';
const REGISTER_ID = 'reg-till-1';
const ADMIN_ID = 'emp-admin';
const DEFAULT_TAX_ID = 'tax-standard-vat';
const ZERO_TAX_ID = 'tax-zero';

const seedStore: Store = {
    id: STORE_ID,
    name: 'My Shop',
    address: '',
    phone: '',
    email: '',
    currency: 'GBP',
    taxIncludedInPrice: true,
    receiptHeader: 'My Shop',
    receiptFooter: 'Thank you for visiting!',
    createdAt: now()
};

const seedRegisters: Register[] = [
    { id: REGISTER_ID, storeId: STORE_ID, name: 'Till 1', isActive: true, createdAt: now() }
];

const seedEmployees: Employee[] = [
    { id: ADMIN_ID, storeId: STORE_ID, name: 'Admin', pin: '1234', role: 'admin', email: '', isActive: true, createdAt: now() }
];

const seedCategories: Category[] = [
    { id: 'cat-pool', name: 'Pool Sessions', color: '#3b82f6', sortOrder: 1, isActive: true, createdAt: now() },
    { id: 'cat-drinks', name: 'Drinks', color: '#ef4444', sortOrder: 2, isActive: true, createdAt: now() },
    { id: 'cat-snacks', name: 'Snacks', color: '#f59e0b', sortOrder: 3, isActive: true, createdAt: now() },
    { id: 'cat-merch', name: 'Merchandise', color: '#10b981', sortOrder: 4, isActive: true, createdAt: now() },
];

const seedTaxRates: TaxRate[] = [
    { id: DEFAULT_TAX_ID, name: 'Standard VAT (20%)', rate: 0.20, isDefault: true, createdAt: now() },
    { id: ZERO_TAX_ID, name: 'Zero-Rated', rate: 0, isDefault: false, createdAt: now() },
];

const seedProducts: Product[] = [
    { id: 'prod-1h-pool', categoryId: 'cat-pool', taxRateId: DEFAULT_TAX_ID, name: '1 Hour Pool', sku: 'POOL-1H', barcode: '', price: 1000, costPrice: 0, stockLevel: 0, trackStock: false, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#3b82f6', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-2h-pool', categoryId: 'cat-pool', taxRateId: DEFAULT_TAX_ID, name: '2 Hours Pool', sku: 'POOL-2H', barcode: '', price: 1800, costPrice: 0, stockLevel: 0, trackStock: false, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#3b82f6', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-coke', categoryId: 'cat-drinks', taxRateId: DEFAULT_TAX_ID, name: 'Coca Cola 330ml', sku: 'DRINK-COKE', barcode: '5000112546312', price: 250, costPrice: 80, stockLevel: 48, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#ef4444', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-diet-coke', categoryId: 'cat-drinks', taxRateId: DEFAULT_TAX_ID, name: 'Diet Coke 330ml', sku: 'DRINK-DCOKE', barcode: '5000112546329', price: 250, costPrice: 80, stockLevel: 48, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#ef4444', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-fanta', categoryId: 'cat-drinks', taxRateId: DEFAULT_TAX_ID, name: 'Fanta Orange 330ml', sku: 'DRINK-FANTA', barcode: '5000112546336', price: 250, costPrice: 80, stockLevel: 36, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#f97316', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-sprite', categoryId: 'cat-drinks', taxRateId: DEFAULT_TAX_ID, name: 'Sprite 330ml', sku: 'DRINK-SPRITE', barcode: '5000112546343', price: 250, costPrice: 80, stockLevel: 24, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#22c55e', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-water', categoryId: 'cat-drinks', taxRateId: ZERO_TAX_ID, name: 'Mineral Water 500ml', sku: 'DRINK-WATER', barcode: '5000112546350', price: 150, costPrice: 40, stockLevel: 100, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#0ea5e9', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-nachos', categoryId: 'cat-snacks', taxRateId: DEFAULT_TAX_ID, name: 'Nachos & Cheese', sku: 'SNACK-NACH', barcode: '5000112546367', price: 650, costPrice: 200, stockLevel: 24, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#f59e0b', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-crisps', categoryId: 'cat-snacks', taxRateId: DEFAULT_TAX_ID, name: 'Salted Crisps', sku: 'SNACK-CRISPS', barcode: '5000112546374', price: 150, costPrice: 50, stockLevel: 60, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#eab308', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-peanuts', categoryId: 'cat-snacks', taxRateId: DEFAULT_TAX_ID, name: 'Roasted Peanuts', sku: 'SNACK-PEANUTS', barcode: '5000112546381', price: 200, costPrice: 60, stockLevel: 40, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#d97706', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-choc-bar', categoryId: 'cat-snacks', taxRateId: DEFAULT_TAX_ID, name: 'Chocolate Bar', sku: 'SNACK-CHOC', barcode: '5000112546398', price: 180, costPrice: 70, stockLevel: 50, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#78350f', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-cue-chalk', categoryId: 'cat-merch', taxRateId: DEFAULT_TAX_ID, name: 'Cue Chalk (Pack of 2)', sku: 'MERCH-CHALK', barcode: '5000112546404', price: 300, costPrice: 100, stockLevel: 20, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#10b981', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-cue-tip', categoryId: 'cat-merch', taxRateId: DEFAULT_TAX_ID, name: 'Replacement Cue Tip', sku: 'MERCH-TIP', barcode: '5000112546411', price: 500, costPrice: 150, stockLevel: 30, trackStock: true, showInGoods: false, goodsSortOrder: 0, isWeighable: false, color: '#14b8a6', image: '', isActive: true, createdAt: now(), updatedAt: now() },

    // Open Price Departments
    { id: 'prod-open-grocery', categoryId: 'cat-snacks', taxRateId: DEFAULT_TAX_ID, name: 'Grocery', sku: 'OPEN-GROCERY', barcode: '', price: 0, costPrice: 0, stockLevel: 0, trackStock: false, showInGoods: true, goodsSortOrder: 0, isWeighable: false, color: '#6366f1', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-open-meat', categoryId: 'cat-snacks', taxRateId: DEFAULT_TAX_ID, name: 'Meat', sku: 'OPEN-MEAT', barcode: '', price: 0, costPrice: 0, stockLevel: 0, trackStock: false, showInGoods: true, goodsSortOrder: 0, isWeighable: false, color: '#ef4444', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-open-beer', categoryId: 'cat-drinks', taxRateId: DEFAULT_TAX_ID, name: 'Beer', sku: 'OPEN-BEER', barcode: '', price: 0, costPrice: 0, stockLevel: 0, trackStock: false, showInGoods: true, goodsSortOrder: 0, isWeighable: false, color: '#f59e0b', image: '', isActive: true, createdAt: now(), updatedAt: now() },
    { id: 'prod-open-tobacco', categoryId: 'cat-merch', taxRateId: DEFAULT_TAX_ID, name: 'Tobacco', sku: 'OPEN-TOBACCO', barcode: '', price: 0, costPrice: 0, stockLevel: 0, trackStock: false, showInGoods: true, goodsSortOrder: 0, isWeighable: false, color: '#52525b', image: '', isActive: true, createdAt: now(), updatedAt: now() },
];

const blankPromoFields = {
    autoApply: false, groupId: '', minQuantity: 1, secondPrice: 0,
    bundleQuantity: 0, bundlePrice: 0, maxApplications: null,
    startAt: '', endAt: '', priority: 0,
};

const seedDiscounts: Discount[] = [
    { id: 'disc-10pct', name: '10% Off', type: 'percentage', value: 10, isActive: true, createdAt: now(), kind: 'manual_percent', ...blankPromoFields },
    { id: 'disc-staff', name: 'Staff Discount (20%)', type: 'percentage', value: 20, isActive: true, createdAt: now(), kind: 'manual_percent', ...blankPromoFields },
    { id: 'disc-5off', name: '£5 Off', type: 'fixed', value: 500, isActive: true, createdAt: now(), kind: 'manual_amount', ...blankPromoFields },
];

const seedSettings: Setting[] = [
    { key: 'store_info', value: JSON.stringify(seedStore), updatedAt: now() },
    { key: 'loyalty_points_per_pound', value: '1', updatedAt: now() },
    { key: 'loyalty_points_to_redeem', value: '100', updatedAt: now() },
    { key: 'loyalty_redemption_value', value: '100', updatedAt: now() },
    { key: 'loyalty_enabled', value: 'true', updatedAt: now() },
    { key: 'receipt_show_logo', value: 'true', updatedAt: now() },
    { key: 'default_order_type', value: 'sale', updatedAt: now() },
    { key: 'stock_tracking_enabled', value: 'true', updatedAt: now() },
    { key: 'cash_up_enabled', value: 'false', updatedAt: now() },
    { key: 'cash_up_require_opening_float', value: 'true', updatedAt: now() },
    { key: 'cash_up_reconcile_card', value: 'true', updatedAt: now() },
    { key: 'role_permissions', value: '', updatedAt: now() },
    { key: 'training_mode_enabled', value: 'false', updatedAt: now() },
];


// ─────────────────────────────────────────────
// STORES — All 19 tables
// ─────────────────────────────────────────────

export const storeDB = writable<Store>(seedStore);
export const registersDB = writable<Register[]>(seedRegisters);
export const employeesDB = writable<Employee[]>(seedEmployees);
export const customersDB = writable<Customer[]>([]);
export const categoriesDB = writable<Category[]>(seedCategories);
export const taxRatesDB = writable<TaxRate[]>(seedTaxRates);
export const productsDB = writable<Product[]>(seedProducts);

/** Update one cached product without reloading the product table. */
export function patchProductInStore(
    patch: Partial<Product> & Pick<Product, 'id'>,
    addIfMissing = false,
): void {
    productsDB.update((products) => {
        const index = products.findIndex((product) => product.id === patch.id);
        if (index === -1) {
            return addIfMissing ? [...products, patch as Product] : products;
        }

        const next = products.slice();
        next[index] = { ...products[index], ...patch };
        return next;
    });
}
export const suppliersDB = writable<Supplier[]>([]);
export const productSuppliersDB = writable<ProductSupplier[]>([]);
export const inventoryLogDB = writable<InventoryLog[]>([]);
export const shiftsDB = writable<Shift[]>([]);
export const cashMovementsDB = writable<CashMovement[]>([]);
export const discountsDB = writable<Discount[]>(seedDiscounts);
export const promoGroupsDB = writable<PromoGroup[]>([]);
export const promoGroupItemsDB = writable<PromoGroupItem[]>([]);
export const ordersDB = writable<Order[]>([]);
export const orderLinesDB = writable<OrderLine[]>([]);
export const paymentsDB = writable<Payment[]>([]);
export const loyaltyLogDB = writable<LoyaltyLog[]>([]);
export const auditLogDB = writable<AuditLog[]>([]);
export const settingsDB = writable<Setting[]>(seedSettings);

// 20. Tile — which products appear on the POS grid and in what order
export interface Tile {
    id: string;
    pageId: string;
    productId: string;
    position: number;       // sort order on the grid
}

const seedTiles: Tile[] = [
    { id: 'tile-1', pageId: 'page-1', productId: 'prod-1h-pool', position: 1 },
    { id: 'tile-2', pageId: 'page-1', productId: 'prod-2h-pool', position: 2 },
    { id: 'tile-3', pageId: 'page-1', productId: 'prod-coke', position: 3 },
    { id: 'tile-4', pageId: 'page-1', productId: 'prod-diet-coke', position: 4 },
    { id: 'tile-5', pageId: 'page-1', productId: 'prod-fanta', position: 5 },
    { id: 'tile-6', pageId: 'page-1', productId: 'prod-sprite', position: 6 },
    { id: 'tile-7', pageId: 'page-1', productId: 'prod-water', position: 7 },
    { id: 'tile-8', pageId: 'page-1', productId: 'prod-nachos', position: 8 },
    { id: 'tile-9', pageId: 'page-1', productId: 'prod-crisps', position: 9 },
    { id: 'tile-10', pageId: 'page-1', productId: 'prod-peanuts', position: 10 },
    { id: 'tile-11', pageId: 'page-1', productId: 'prod-choc-bar', position: 11 },
];

export const tilesDB = writable<Tile[]>(seedTiles);

// 21. PosPage — custom pages for POS screen layout
export interface PosPage {
    id: string;
    name: string;
    position: number;
    color: string;
}

const seedPosPages: PosPage[] = [
    { id: 'page-1', name: 'Main Items', position: 1, color: '#3b82f6' },
];

export const posPagesDB = writable<PosPage[]>(seedPosPages);


// ─────────────────────────────────────────────
// DERIVED STORES (Convenience lookups)
// ─────────────────────────────────────────────

function normalizeLookupCode(value: string | undefined) {
    return String(value || '').trim();
}

/** Active products and lookup indexes cached for POS remounts. */
export const activeProducts = writable<Product[]>(seedProducts.filter(p => p.isActive));
export const goodsProducts = writable<Product[]>(seedProducts.filter(p => p.isActive && p.showInGoods));
export const weighableProducts = writable<Product[]>(seedProducts.filter(p => p.isActive && p.isWeighable));
export const productById = writable<Map<string, Product>>(new Map(seedProducts.map(product => [product.id, product])));
export const activeProductById = writable<Map<string, Product>>(new Map(seedProducts.filter(p => p.isActive).map(product => [product.id, product])));
export const productByBarcode = writable<Map<string, Product>>(new Map(
    seedProducts
        .filter(product => product.isActive && product.barcode?.trim())
        .map(product => [normalizeLookupCode(product.barcode), product])
));
export const scaleProductByPlu = writable<Map<string, Product>>(new Map(
    seedProducts
        .filter(product => product.isActive && product.scalePlu?.trim())
        .map(product => [normalizeLookupCode(product.scalePlu), product])
));
export const weighableProductById = writable<Map<string, Product>>(new Map(
    seedProducts
        .filter(product => product.isActive && product.isWeighable)
        .map(product => [product.id, product])
));
export const activeProductIds = writable<Set<string>>(new Set(seedProducts.filter(p => p.isActive).map(product => product.id)));

productsDB.subscribe((products) => {
    const active: Product[] = [];
    const goods: Product[] = [];
    const weighable: Product[] = [];
    const byId = new Map<string, Product>();
    const activeById = new Map<string, Product>();
    const byBarcode = new Map<string, Product>();
    const byScalePlu = new Map<string, Product>();
    const weighableById = new Map<string, Product>();
    const activeIds = new Set<string>();

    for (const product of products) {
        byId.set(product.id, product);
        if (!product.isActive) continue;

        active.push(product);
        activeById.set(product.id, product);
        activeIds.add(product.id);

        const barcode = normalizeLookupCode(product.barcode);
        if (barcode) byBarcode.set(barcode, product);

        const scalePlu = normalizeLookupCode(product.scalePlu);
        if (scalePlu) byScalePlu.set(scalePlu, product);

        if (product.showInGoods) goods.push(product);
        if (product.isWeighable) {
            weighable.push(product);
            weighableById.set(product.id, product);
        }
    }

    goods.sort((a, b) => (a.goodsSortOrder || 0) - (b.goodsSortOrder || 0));

    activeProducts.set(active);
    goodsProducts.set(goods);
    weighableProducts.set(weighable);
    productById.set(byId);
    activeProductById.set(activeById);
    productByBarcode.set(byBarcode);
    scaleProductByPlu.set(byScalePlu);
    weighableProductById.set(weighableById);
    activeProductIds.set(activeIds);
});

/** Active categories sorted by sortOrder */
export const activeCategories = derived(categoriesDB, ($c) =>
    $c.filter(c => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder)
);

/** Pos pages sorted by position */
export const activePosPages = derived(posPagesDB, ($p) =>
    $p.slice().sort((a, b) => a.position - b.position)
);

/** Currently open shift (if any) */
export const currentShift = derived(shiftsDB, ($s) =>
    $s.find(s => s.status === 'open') || null
);

/** Held orders */
export const heldOrders = derived(ordersDB, ($o) =>
    $o.filter(o => o.status === 'hold')
);

/** Default tax rate */
export const defaultTaxRate = derived(taxRatesDB, ($t) =>
    $t.find(t => t.isDefault) || null
);

/** Get a setting value by key */
export function getSetting(key: string): string | null {
    const settings = get(settingsDB);
    const s = settings.find(s => s.key === key);
    return s ? s.value : null;
}

/** Update a setting value */
export function setSetting(key: string, value: string) {
    settingsDB.update(settings => {
        const idx = settings.findIndex(s => s.key === key);
        if (idx >= 0) {
            settings[idx].value = value;
            settings[idx].updatedAt = now();
        } else {
            settings.push({ key, value, updatedAt: now() });
        }
        return settings;
    });
}


// ─────────────────────────────────────────────
// HELPER: Lookup functions
// ─────────────────────────────────────────────

export function getCategoryName(categoryId: string): string {
    const cats = get(categoriesDB);
    return cats.find(c => c.id === categoryId)?.name || 'Unknown';
}

export function getTaxRate(taxRateId: string): number {
    const rates = get(taxRatesDB);
    return rates.find(t => t.id === taxRateId)?.rate || 0;
}

export function getEmployeeName(employeeId: string): string {
    const emps = get(employeesDB);
    return emps.find(e => e.id === employeeId)?.name || 'Unknown';
}

export function getProductBySku(sku: string): Product | undefined {
    const prods = get(productsDB);
    return prods.find(p => p.sku === sku && p.isActive);
}


// ─────────────────────────────────────────────
// HELPER: Audit logging
// ─────────────────────────────────────────────

export function logAudit(
    employeeId: string,
    action: string,
    entityType: string,
    entityId: string,
    oldData: unknown = null,
    newData: unknown = null
) {
    auditLogDB.update(logs => [
        ...logs,
        {
            id: uuid(),
            employeeId,
            action,
            entityType,
            entityId,
            oldData: oldData ? JSON.stringify(oldData) : '',
            newData: newData ? JSON.stringify(newData) : '',
            createdAt: now()
        }
    ]);
}
