<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte";
    import { get } from "svelte/store";
    import { goto } from "$app/navigation";
    import { isTauri } from "@tauri-apps/api/core";
    import { playErrorSound, playItemAddedSound, playSuccessSound } from "$lib/sounds";
    import {
        productsDB,
        employeesDB,
        customersDB,
        taxRatesDB,
        activeCategories,
        activePosPages,
        activeProducts,
        storeDB,
        tilesDB,
        ordersDB,
        orderLinesDB,
        paymentsDB,
        inventoryLogDB,
        loyaltyLogDB,
        auditLogDB,
        registersDB,
        discountsDB,
        promoGroupsDB,
        promoGroupItemsDB,
        formatMoney,
        toPence,
        now,
        uuid,
        settingsDB,
        type Customer,
        type Discount,
        type Employee,
        type Order,
        type OrderLine,
        type Payment,
        type Product,
    } from "$lib/stores/db";
    import { toast } from "$lib/stores/toast";
    import {
        searchProduct,
        searchProductByScalePlu,
        addProduct,
        updateProductFields,
        upsert,
        remove as removeSql,
        getOrCreateTillId,
        getTillName,
        triggerSync,
        commitSale,
        ensureOpenShift,
        findOpenShiftForRegister,
        retireOpenShiftsBefore,
        ensureTillReceiptSequence,
        recordManagerApproval,
        getPosHeldOrders,
        getPosRecentReceipts,
        getLatestTillReceipt,
        getOrderDetails,
        getOrderReversalContext,
        type SaleBundle,
    } from "$lib/stores/database";
    import { evaluateCart, type CartEvaluation } from "$lib/utils/discountEngine";
    import { calculateCartTotals, calculateTaxLine } from "$lib/utils/commerceMath";
    import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
    import CustomSelect from "$lib/components/CustomSelect.svelte";
    import Receipt from "$lib/components/Receipt.svelte";
    import { getReceiptDesign } from "$lib/receipt";
    import { authenticateEmployeePin, currentEmployee, currentShiftId, logout, restoreRememberedEmployeeSession, verifyEmployeePin } from "$lib/stores/session";
    import { connectionState } from "$lib/stores/connection";
    import { getBarcodeRules, parseScaleBarcode } from "$lib/barcodeRules";
    import { getScaleSaleDisplay } from "$lib/scaleSale";
    import { getLoyaltyConfig, loyaltyCredit, pointsForCredit, pointsForSpend } from "$lib/loyalty";
    import TouchDigitPad from "$lib/components/TouchDigitPad.svelte";
    import { broadcastCustomerDisplay, type CustomerDisplayState } from "$lib/customerDisplay";
    import { allocateRefundLines, allocateRefundPayment, getRemainingRefundAmount } from "$lib/refunds";
    import { sendCctvItemAdded, sendCctvReceipt } from "$lib/cctvPos";
    import { cashDrawerTargetLabel, getCashDrawerConfig, openCashDrawer } from "$lib/cashDrawer";
    import { getLabelPrinterConfig, getReceiptPrinterConfig, printEscposReceipt, printProductLabels, sendEscposReceipt } from "$lib/printers";
    import { getLabelDesign } from "$lib/labels";
    import { formatScaleReading, getScaleHardwareConfig, readScaleWeight, type ScaleWeightReading } from "$lib/scaleHardware";
    import { hasPermission, permissionLabels, type PermissionKey } from "$lib/permissions";

    type PosOrderSummary = Order & {
        cashierName?: string;
        tillName?: string;
        customerName?: string;
    };

    let activePageId = "";
    let currentPageIndex = 0;
    let searchQuery = "";
    let scanInput: HTMLInputElement;
    let scannerFocusTimer: ReturnType<typeof setTimeout> | undefined;
    let scannerBuffer = "";
    let scannerLastKeyAt = 0;
    let scannerBufferTimer: ReturnType<typeof setTimeout> | undefined;
    let hasStartedTypingPrice = false;

    // Cart
    let cart: {
        id: string;
        name: string;
        price: number;
        quantity: number;
        note: string;
        isPriceOverride?: boolean;
        originalPrice?: number;
        sourceBarcode?: string;
        quantityLocked?: boolean;
        skipStockAdjustment?: boolean;
    }[] = [];
    let selectedCartIndex = 0;
    let customerDisplayCompleteUntil = 0;
    let customerDisplayChange = 0;
    const MAX_CART_QUANTITY = 9999;

    let showNumpad = false;
    let numpadValue = "";
    let showChangePricePad = false;
    let changePriceString = "";

    let showGoodsModal = false;
    let goodsPriceString = "0";
    let showHeldOrders = false;
    let showPaymentModal = false;
    let showDiscountModal = false;
    let selectedManualDiscountId = "";
    let paymentMethod: "cash" | "card" = "cash";
    let amountTenderedString = "0";
    let hasTypedPayment = false;
    let cartItemEls: HTMLElement[] = [];
    let cartScrollFrame: number | undefined;
    let lastCartScrollIndex = -1;
    let customerSearch = "";
    let selectedCustomerId = "";
    let useLoyaltyCredit = false;
    let customerSearchInput: HTMLInputElement;
    $: loyaltyConfig = getLoyaltyConfig($settingsDB);
    $: selectedCustomer = $customersDB.find((customer) => customer.id === selectedCustomerId) || null;
    $: availableLoyaltyCredit = selectedCustomer && loyaltyConfig.enabled ? loyaltyCredit(selectedCustomer.loyaltyPoints, loyaltyConfig) : 0;
    $: loyaltyRedemptionAvailable = $connectionState.mode !== "multi" || $connectionState.mysqlOnline;
    $: loyaltyCreditUsed = useLoyaltyCredit ? Math.min(total, availableLoyaltyCredit) : 0;
    $: loyaltyPointsRedeemed = pointsForCredit(loyaltyCreditUsed, loyaltyConfig);
    $: paymentDue = Math.max(0, total - loyaltyCreditUsed);
    $: loyaltyPointsEarned = selectedCustomer && loyaltyConfig.enabled ? pointsForSpend(paymentDue, loyaltyConfig) : 0;
    $: paymentInputAmount = parseInt(amountTenderedString) || 0;
    $: cardCashPartInvalid = paymentMethod === "card" && paymentInputAmount > 0 && paymentInputAmount >= paymentDue;
    $: paymentCompleteDisabled =
        isCompletingSale ||
        (paymentMethod === "cash" && paymentInputAmount < paymentDue) ||
        cardCashPartInvalid;
    $: customerMatches = customerSearch.trim()
        ? $customersDB.filter((customer) => {
            const query = customerSearch.trim().toLowerCase();
            return [customer.name, customer.loyaltyCode, customer.phone, customer.postcode]
                .some((value) => String(value || "").toLowerCase().includes(query));
        }).slice(0, 5)
        : [];

    let showNotFoundModal = false;
    let notFoundBarcode = "";
    let showQuickAddModal = false;
    let showScaleModal = false;
    let selectedScaleProductId = "";
    let scaleWeightInput = "";
    let scaleWeightUnit: "g" | "kg" = "kg";
    let scaleSearch = "";
    let scalePage = 0;
    let activeScaleTilePageId = "";
    let scaleReadBusy = false;
    let scaleReadStatus = "";
    let scalePollTimer: ReturnType<typeof setInterval> | undefined;
    let scalePollingSignature = "";
    const SCALE_PRODUCTS_PER_PAGE = 9;
    const POS_TILES_PER_PAGE = 16;
    const MAX_SCALE_WEIGHT_DIGITS = 6;
    const MAX_ORDER_TOTAL_PENCE = 999_999_999;
    let quickAddName = "";
    let quickAddSku = "";
    let quickAddPrice = "0";
    let quickAddCategoryId = "";
    let quickAddTaxRateId = "";
    let quickAddBusy = false;
    let showClearConfirm = false;
    let showReversalConfirm = false;
    let showPartialRefundPad = false;
    let pendingReversal: { orderId: string; partial: boolean; voiding: boolean; approved?: boolean } | null = null;
    let partialRefundInput = "";
    let isReversingOrder = false;
    let isCompletingSale = false;
    let isHoldingOrder = false;
    let drawerBusy = false;
    let selectedLoginEmployeeId = "";
    let loginPin = "";
    let loginError = "";
    let showManagerApprovalModal = false;
    let managerApprovalPermission: PermissionKey = "price_override";
    let managerApprovalTitle = "";
    let managerApprovalEntityType = "";
    let managerApprovalEntityId = "";
    let managerApprovalNotes = "";
    let managerApprovalEmployeeId = "";
    let managerApprovalPin = "";
    let managerApprovalError = "";
    let managerApprovalAction: (() => Promise<void> | void) | null = null;
    let pendingShiftEmployee: Employee | null = null;
    let openingFloatString = "0";
    let lastRevokedEmployeeId = "";
    let rememberedSessionChecked = false;
    let restoringRememberedSession = false;
    $: activeLoginEmployees = $employeesDB
        .filter((employee) => employee.isActive)
        .sort((a, b) => a.name.localeCompare(b.name));
    $: selectedLoginEmployee = activeLoginEmployees.find((employee) => employee.id === selectedLoginEmployeeId) || null;
    $: managerApprovers = $employeesDB
        .filter((employee) => employee.isActive && hasPermission(employee, managerApprovalPermission, $settingsDB))
        .sort((a, b) => a.name.localeCompare(b.name));
    $: if (showManagerApprovalModal && (!managerApprovalEmployeeId || !managerApprovers.some((employee) => employee.id === managerApprovalEmployeeId))) {
        managerApprovalEmployeeId = managerApprovers[0]?.id || "";
    }
    $: {
        const sessionEmployee = $currentEmployee;
        if (sessionEmployee) {
            const latestEmployee = $employeesDB.find((employee) => employee.id === sessionEmployee.id);
            if (!latestEmployee?.isActive) {
                if (lastRevokedEmployeeId !== sessionEmployee.id) {
                    lastRevokedEmployeeId = sessionEmployee.id;
                    toast("Your staff account is no longer active. Sign in with an active user.", "error");
                }
                logout();
            } else {
                lastRevokedEmployeeId = "";
                if (latestEmployee !== sessionEmployee) currentEmployee.set(latestEmployee);
            }
        }
    }
    $: if (!rememberedSessionChecked && !$currentEmployee && $employeesDB.length > 0) {
        rememberedSessionChecked = true;
        void restoreLastEmployeeSession();
    }
    $: syncLabel = $connectionState.mode === "single"
        ? "Local"
        : $connectionState.mode === "multi"
            ? ($connectionState.mysqlOnline ? ($connectionState.syncError ? "Sync issue" : "Synced") : "Offline")
            : "Setup";
    $: syncStyle = syncLabel === "Synced"
        ? "sync-pill-ok"
        : syncLabel === "Offline" || syncLabel === "Sync issue"
            ? "sync-pill-danger"
            : "sync-pill-neutral";
    $: cashDrawerConfig = getCashDrawerConfig($settingsDB);
    $: receiptPrinterConfig = getReceiptPrinterConfig($settingsDB);
    $: scaleHardwareConfig = getScaleHardwareConfig($settingsDB);
    $: cashDrawerTarget = cashDrawerTargetLabel(cashDrawerConfig);

    let goodsSearchQuery = "";
    $: filteredGoods = $activeProducts
        .filter((p) => p.showInGoods)
        .sort((a, b) => (a.goodsSortOrder || 0) - (b.goodsSortOrder || 0))
        .filter((p) =>
            p.name.toLowerCase().includes(goodsSearchQuery.toLowerCase()),
        );

    let trolleyMessage = "";
    let trolleyMessageType: "info" | "error" | "success" = "info";
    let trolleyMessageTimeout: any;

    const cartLayoutDefault = ['goods', 'last_receipt', 'change_price', 'hold'];
    const toolbarLayoutDefault = ['scale', 'recent_trans', 'label_print', 'discount'];
    const allowedCartLayoutKeys = new Set(['goods', 'last_receipt', 'change_price', 'hold', 'scale', 'discount']);
    const allowedToolbarLayoutKeys = new Set(['scale', 'label_print', 'discount', 'goods', 'recent_trans', 'change_price']);

    function parsePosLayout(value: string | undefined, fallback: string[], allowedKeys: Set<string>, area: "cart" | "toolbar") {
        try {
            const parsed = JSON.parse(value || "");
            if (!Array.isArray(parsed)) return fallback;
            const valid = parsed
                .map((key) => key === "drawer" ? "label_print" : key)
                .map((key) => area === "cart" && key === "recent_trans" ? "last_receipt" : key)
                .map((key) => area === "cart" && key === "label_print" ? "hold" : key)
                .filter((key): key is string => typeof key === "string" && allowedKeys.has(key));
            return valid.length > 0 ? [...new Set(valid)] : fallback;
        } catch {
            return fallback;
        }
    }

    function ensureRecentNextToScale(layout: string[]) {
        const withoutRecent = layout.filter((key) => key !== "recent_trans");
        const scaleIndex = withoutRecent.indexOf("scale");
        if (scaleIndex === -1) return ["recent_trans", ...withoutRecent];
        return [
            ...withoutRecent.slice(0, scaleIndex + 1),
            "recent_trans",
            ...withoutRecent.slice(scaleIndex + 1),
        ];
    }

    $: cartLayout = parsePosLayout($settingsDB.find(s => s.key === 'pos_cart_layout')?.value, cartLayoutDefault, allowedCartLayoutKeys, "cart");
    $: toolbarLayout = ensureRecentNextToScale(parsePosLayout($settingsDB.find(s => s.key === 'pos_toolbar_layout')?.value, toolbarLayoutDefault, allowedToolbarLayoutKeys, "toolbar"));
    $: stockTrackingEnabled = ($settingsDB.find(s => s.key === 'stock_tracking_enabled')?.value ?? 'true') !== 'false';
    $: trainingModeEnabled = ($settingsDB.find(s => s.key === 'training_mode_enabled')?.value ?? 'false') === 'true';
    $: scaleTilePages = (() => {
        try {
            const pageValue = $settingsDB.find(s => s.key === "scale_tile_pages")?.value;
            if (pageValue) return JSON.parse(pageValue) as { id: string; name: string; color: string; productIds: string[] }[];
            const legacyIds = JSON.parse($settingsDB.find(s => s.key === "scale_tile_product_ids")?.value || "[]") as string[];
            return [{ id: "scale-default", name: "All Scale Items", color: "#10b981", productIds: legacyIds }];
        } catch {
            return [{ id: "scale-default", name: "All Scale Items", color: "#10b981", productIds: [] }];
        }
    })();
    $: if (!activeScaleTilePageId || !scaleTilePages.some((page) => page.id === activeScaleTilePageId)) activeScaleTilePageId = scaleTilePages[0]?.id || "";
    $: activeScaleTilePage = scaleTilePages.find((page) => page.id === activeScaleTilePageId);
    $: allWeighableProducts = $activeProducts.filter((product) => product.isWeighable);
    $: configuredScaleProducts = activeScaleTilePage?.productIds.length
        ? activeScaleTilePage.productIds.map((id) => allWeighableProducts.find((product) => product.id === id)).filter(Boolean)
        : scaleTilePages.length === 1 && !$settingsDB.find(s => s.key === "scale_tile_pages")
            ? allWeighableProducts
            : [];
    $: visibleScaleProducts = configuredScaleProducts.filter((product) =>
        product && productMatchesScaleSearch(product, scaleSearch),
    );
    $: scalePageCount = Math.max(1, Math.ceil(visibleScaleProducts.length / SCALE_PRODUCTS_PER_PAGE));
    $: if (scalePage >= scalePageCount) scalePage = scalePageCount - 1;
    $: pagedScaleProducts = visibleScaleProducts.slice(
        scalePage * SCALE_PRODUCTS_PER_PAGE,
        (scalePage + 1) * SCALE_PRODUCTS_PER_PAGE,
    );
    $: selectedScaleProduct = allWeighableProducts.find((product) => product.id === selectedScaleProductId);
    $: scaleWeightKg = scaleWeightUnit === "g"
        ? (parseFloat(scaleWeightInput) || 0) / 1000
        : parseFloat(scaleWeightInput) || 0;
    $: scaleLinePrice = Math.round(scaleWeightKg * (selectedScaleProduct?.price || 0));
    $: scaleHardwareReady = scaleHardwareConfig.enabled && Boolean(scaleHardwareConfig.devicePath.trim());
    $: {
        const nextSignature = showScaleModal && scaleHardwareReady
            ? `${scaleHardwareConfig.devicePath.trim()}|${scaleHardwareConfig.baudRate}|${scaleHardwareConfig.pollMs}`
            : "";
        if (nextSignature !== scalePollingSignature) {
            stopScalePolling();
            scalePollingSignature = nextSignature;
            if (nextSignature) startScalePolling();
        }
    }

    function showTrolleyFeedback(
        msg: string,
        type: "info" | "error" | "success" = "info",
    ) {
        trolleyMessage = msg;
        trolleyMessageType = type;
        if (trolleyMessageTimeout) clearTimeout(trolleyMessageTimeout);
        trolleyMessageTimeout = setTimeout(() => {
            trolleyMessage = "";
        }, 2000);
    }

    function scannerFocusBlocked(): boolean {
        if (typeof document === "undefined") return true;
        return !$currentEmployee ||
            showNumpad ||
            showChangePricePad ||
            showGoodsModal ||
            showHeldOrders ||
            showPaymentModal ||
            showDiscountModal ||
            showNotFoundModal ||
            showQuickAddModal ||
            showScaleModal ||
            showClearConfirm ||
            showReversalConfirm ||
            showPartialRefundPad ||
            showRecentTransactions ||
            isHoldingOrder ||
            isCompletingSale ||
            Boolean(document.querySelector(".touch-input-backdrop"));
    }

    function focusScannerSoon(force = false) {
        if (typeof document === "undefined") return;
        if (scannerFocusTimer) clearTimeout(scannerFocusTimer);
        scannerFocusTimer = setTimeout(async () => {
            await tick();
            if (!scanInput || scannerFocusBlocked()) return;
            const active = document.activeElement as HTMLElement | null;
            const editingAnotherField = active &&
                active !== scanInput &&
                (active.matches("input, textarea, select, [contenteditable='true']") ||
                    Boolean(active.closest("[contenteditable='true']")));
            if (!force && editingAnotherField) return;
            scanInput.focus({ preventScroll: true });
        }, 0);
    }

    function clearScannerBuffer() {
        scannerBuffer = "";
        scannerLastKeyAt = 0;
        if (scannerBufferTimer) clearTimeout(scannerBufferTimer);
        scannerBufferTimer = undefined;
    }

    function handleGlobalScannerKeydown(event: KeyboardEvent) {
        if (scannerFocusBlocked()) return;
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

        const active = document.activeElement as HTMLElement | null;
        if (active === scanInput) return;
        if (active?.matches("input, textarea, select, [contenteditable='true']")) return;

        if (event.key === "Enter") {
            const scanned = scannerBuffer.trim();
            clearScannerBuffer();
            if (scanned.length < 4) return;
            event.preventDefault();
            searchQuery = scanned;
            void handleSearch().finally(() => focusScannerSoon(true));
            return;
        }

        if (event.key.length !== 1 || !/^[A-Za-z0-9._-]$/.test(event.key)) return;

        const nowMs = Date.now();
        if (scannerLastKeyAt && nowMs - scannerLastKeyAt > 120) scannerBuffer = "";
        scannerLastKeyAt = nowMs;
        scannerBuffer += event.key;
        if (scannerBuffer.length > 64) scannerBuffer = scannerBuffer.slice(-64);
        if (scannerBufferTimer) clearTimeout(scannerBufferTimer);
        scannerBufferTimer = setTimeout(clearScannerBuffer, 350);
    }

    function handlePosPointerUp(event: PointerEvent) {
        const element = event.target as Element | null;
        if (!element || element.closest(".modal-overlay, .touch-input-backdrop, [role='dialog']")) return;
        if (element.matches("input, textarea, select, [contenteditable='true']")) return;
        focusScannerSoon();
    }

    function scheduleSelectedCartScroll(index: number) {
        if (typeof requestAnimationFrame === "undefined") return;
        if (cartScrollFrame) cancelAnimationFrame(cartScrollFrame);
        cartScrollFrame = requestAnimationFrame(() => {
            cartScrollFrame = undefined;
            cartItemEls[index]?.scrollIntoView({
                behavior: "auto",
                block: "nearest",
            });
        });
    }

    $: {
        if (cart.length === 0) {
            lastCartScrollIndex = -1;
        } else if (selectedCartIndex >= 0 && selectedCartIndex !== lastCartScrollIndex && cartItemEls[selectedCartIndex]) {
            lastCartScrollIndex = selectedCartIndex;
            scheduleSelectedCartScroll(selectedCartIndex);
        }
    }

    $: {
        if ($activePosPages.length > 0 && !$activePosPages.some((page) => page.id === activePageId)) {
            activePageId = $activePosPages[0].id;
            currentPageIndex = 0;
        } else if ($activePosPages.length === 0) {
            activePageId = "";
        }
    }

    $: activePageTiles = $tilesDB
        .filter((t) => t.pageId === activePageId)
        .sort((a, b) => a.position - b.position);
    $: activeProductById = new Map($activeProducts.map((product) => [product.id, product]));
    $: productById = new Map($productsDB.map((product) => [product.id, product]));
    $: productByBarcode = new Map(
        $activeProducts
            .filter((product) => product.showInPos !== false && product.barcode?.trim())
            .map((product) => [normalizeLookupCode(product.barcode), product]),
    );
    $: scaleProductByPlu = new Map(
        $activeProducts
            .filter((product) => product.showInPos !== false && product.scalePlu?.trim())
            .map((product) => [normalizeLookupCode(product.scalePlu || ""), product]),
    );
    $: activeProductIds = new Set($activeProducts.map((product) => product.id));
    $: employeeById = new Map($employeesDB.map((employee) => [employee.id, employee]));
    $: registerById = new Map($registersDB.map((register) => [register.id, register]));

    function normalizeLookupCode(value: string | undefined) {
        return String(value || "").trim();
    }

    function asBoolean(value: unknown, fallback = false) {
        if (value === undefined || value === null || value === "") return fallback;
        if (typeof value === "boolean") return value;
        if (typeof value === "number") return value !== 0;
        return String(value).toLowerCase() === "true" || value === "1";
    }

    function normalizeProductForCache(product: any): Product {
        return {
            ...product,
            trackStock: asBoolean(product.trackStock),
            allowPriceOverride: asBoolean(product.allowPriceOverride),
            isWeighable: asBoolean(product.isWeighable),
            showInGoods: asBoolean(product.showInGoods),
            showInPos: asBoolean(product.showInPos, true),
            isActive: asBoolean(product.isActive, true),
        } as Product;
    }

    function rememberProductInPosCache(product: any) {
        if (!product?.id) return;
        const normalized = normalizeProductForCache(product);
        productsDB.update((items) => {
            const index = items.findIndex((item) => item.id === normalized.id);
            if (index === -1) return [...items, normalized];
            const next = items.slice();
            next[index] = { ...items[index], ...normalized };
            return next;
        });
    }

    $: totalPages = Math.max(
        1,
        Math.ceil(
            (activePageTiles.length > 0
                ? Math.max(...activePageTiles.map((t) => t.position))
                : 0) / POS_TILES_PER_PAGE,
        ),
    );

    $: if (currentPageIndex >= totalPages)
        currentPageIndex = Math.max(0, totalPages - 1);

    $: displayTiles = Array.from({ length: POS_TILES_PER_PAGE }, (_, i) => {
        const absolutePos = currentPageIndex * POS_TILES_PER_PAGE + i + 1; // 1-indexed
        const tile = activePageTiles.find((t) => t.position === absolutePos);
        if (!tile) return null;
        return {
            tile,
            product: activeProductById.get(tile.productId),
        };
    });

    $: totalItems = cart.reduce((acc, item) => acc + item.quantity, 0);
    $: subtotal = cart.reduce(
        (acc, item) => acc + item.price * item.quantity,
        0,
    );
    $: manualPercentageDiscount = $discountsDB.find(
        (d) => d.id === selectedManualDiscountId && d.kind === "manual_percent" && d.isActive,
    );
    $: eligiblePromoGroupItems = $promoGroupItemsDB.filter((membership) =>
        activeProductIds.has(membership.productId),
    );
    $: cartEval = applyManualPercentageDiscount(
        evaluateCart(
            cart.map((c) => ({
                id: c.id,
                price: c.price,
                quantity: c.quantity,
                basePrice: c.originalPrice || c.price,
            })),
            $discountsDB,
            $promoGroupsDB,
            eligiblePromoGroupItems,
            promoClock,
        ),
        manualPercentageDiscount,
        cart,
    );
    $: promoSavings = cartEval.totalSavings;
    $: selectedPromotionNotice = getCartPromotionNotice(cartEval.lines[selectedCartIndex]);
    $: if (cart.length === 0) selectedManualDiscountId = "";
    let taxTotal = 0;
    let total = 0;
    $: calculatedTaxLines = cart.map((item, i) => {
        const product = productById.get(item.id);
        const taxRate = $taxRatesDB.find((t) => t.id === product?.taxRateId)?.rate || 0;
        return calculateTaxLine({
            quantity: item.quantity,
            unitPrice: item.price,
            discountAmount: cartEval.lines[i]?.savings || 0,
            taxRate,
            taxIncludedInPrice: $storeDB.taxIncludedInPrice,
        });
    });
    $: ({ taxTotal, total } = calculateCartTotals(calculatedTaxLines));
    $: customerDisplayState = ({
        storeName: $storeDB.name,
        tillName: tillName || tillId,
        lines: cart.map((item, index) => ({
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.price,
            total: item.price * item.quantity,
            discount: cartEval.lines[index]?.savings || 0,
        })),
        subtotal,
        discount: promoSavings,
        total,
        status: Date.now() < customerDisplayCompleteUntil
            ? "complete"
            : showPaymentModal ? "payment" : "shopping",
        message: Date.now() < customerDisplayCompleteUntil ? "Thank you for shopping with us" : "",
        change: customerDisplayChange,
    } satisfies CustomerDisplayState);
    $: void broadcastCustomerDisplay(customerDisplayState);

    function applyManualPercentageDiscount(
        evaluation: CartEvaluation,
        discount: { id: string; name: string; value: number } | undefined,
        cartLines: typeof cart,
    ): CartEvaluation {
        if (!discount) return evaluation;
        const lines = evaluation.lines.map((line, index) => {
            const lineGross = cartLines[index].price * cartLines[index].quantity;
            const remaining = Math.max(0, lineGross - line.savings);
            const saving = Math.min(remaining, Math.round(remaining * discount.value / 100));
            if (saving <= 0) return line;
            return {
                ...line,
                savings: line.savings + saving,
                applied: [...line.applied, {
                    discountId: discount.id,
                    discountName: discount.name,
                    savings: saving,
                }],
            };
        });
        return { lines, totalSavings: lines.reduce((sum, line) => sum + line.savings, 0) };
    }

    type CartPromoNotice = {
        kind: "applied" | "eligible";
        label: string;
        detail: string;
        title: string;
    };

    function promoNameSummary(names: string[]) {
        if (names.length === 0) return "Promotion";
        return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
    }

    function discountDealText(discount: Discount | undefined) {
        if (!discount) return "";
        if (discount.kind === "bundle_fixed_price" && discount.bundleQuantity > 1 && discount.bundlePrice > 0) {
            return `Buy ${discount.bundleQuantity} for ${formatMoney(discount.bundlePrice)}`;
        }
        if (discount.kind === "bogo_fixed_price" && discount.minQuantity >= 1 && discount.secondPrice >= 0) {
            const setSize = discount.minQuantity + 1;
            return `Buy ${setSize}: ${setSize === 2 ? "2nd" : "last"} ${formatMoney(discount.secondPrice)}`;
        }
        if (discount.kind === "temporary_item") {
            return discount.type === "percentage"
                ? `${discount.value}% off`
                : `Offer price ${formatMoney(discount.value)}`;
        }
        return "";
    }

    function eligiblePromotionDetail(line: CartEvaluation["lines"][number]) {
        const deals = line.eligibleFor
            .map((promo) => discountDealText($discountsDB.find((discount) => discount.id === promo.discountId)))
            .filter(Boolean);
        if (deals.length > 0) return deals.length === 1 ? deals[0] : `${deals[0]} +${deals.length - 1} more`;
        const names = line.eligibleFor.map((promo) => promo.discountName);
        return `${promoNameSummary(names)} available`;
    }

    function getCartPromotionNotice(line: CartEvaluation["lines"][number] | undefined): CartPromoNotice | null {
        if (!line) return null;
        if (line.applied.length > 0) {
            const names = line.applied.map((promo) => promo.discountName);
            const savings = line.applied.reduce((sum, promo) => sum + promo.savings, 0);
            const nameText = promoNameSummary(names);
            return {
                kind: "applied",
                label: "Promo",
                detail: `${nameText} applied - ${formatMoney(savings)} saved`,
                title: line.applied.map((promo) => `${promo.discountName}: ${formatMoney(promo.savings)} saved`).join(", "),
            };
        }
        if (line.eligibleFor.length > 0) {
            const names = line.eligibleFor.map((promo) => promo.discountName);
            return {
                kind: "eligible",
                label: "Offer",
                detail: eligiblePromotionDetail(line),
                title: line.eligibleFor.map((promo) => promo.discountName).join(", "),
            };
        }
        return null;
    }

    function openDiscounts() {
        if (cart.length === 0) {
            toast("Add an item before applying a discount", "error");
            return;
        }
        void requirePermission("manual_discount", "Apply manual discount", () => {
            showDiscountModal = true;
        });
    }

    async function requirePermission(
        permission: PermissionKey,
        title: string,
        action: () => Promise<void> | void,
        entityType = "",
        entityId = "",
        notes = "",
    ) {
        if (hasPermission($currentEmployee, permission, $settingsDB)) {
            await action();
            return;
        }
        managerApprovalPermission = permission;
        managerApprovalTitle = title;
        managerApprovalEntityType = entityType;
        managerApprovalEntityId = entityId;
        managerApprovalNotes = notes;
        managerApprovalPin = "";
        managerApprovalError = "";
        managerApprovalAction = action;
        showManagerApprovalModal = true;
    }

    async function approveManagerAction() {
        if (!managerApprovalEmployeeId) {
            managerApprovalError = "Choose a manager or admin";
            return;
        }
        const approver = await verifyEmployeePin(managerApprovalEmployeeId, managerApprovalPin);
        if (!approver || !hasPermission(approver, managerApprovalPermission, $settingsDB)) {
            managerApprovalError = "PIN does not approve this action";
            managerApprovalPin = "";
            return;
        }
        const action = managerApprovalAction;
        showManagerApprovalModal = false;
        managerApprovalPin = "";
        managerApprovalError = "";
        managerApprovalAction = null;
        await recordManagerApproval({
            id: uuid(),
            requestedByEmployeeId: $currentEmployee?.id || "",
            approvedByEmployeeId: approver.id,
            action: managerApprovalPermission,
            entityType: managerApprovalEntityType,
            entityId: managerApprovalEntityId,
            notes: managerApprovalNotes || managerApprovalTitle,
            createdAt: now(),
            updatedAt: now(),
        });
        await action?.();
    }

    function selectManualDiscount(id: string) {
        selectedManualDiscountId = id;
        showDiscountModal = false;
        toast(id ? "Discount applied" : "Manual discount removed", "success");
    }

    function activeTemporaryOffer(productId: string, normalPrice: number, clock: string) {
        const current = new Date(clock).getTime();
        if (!Number.isFinite(current)) return null;
        const discount = $discountsDB.find((d) => {
            if (d.kind !== "temporary_item" || !d.isActive || !d.autoApply) return false;
            if (d.startAt && current < new Date(d.startAt).getTime()) return false;
            if (d.endAt && current > new Date(d.endAt).getTime()) return false;
            const group = $promoGroupsDB.find((g) => g.id === d.groupId);
            if (!group?.isActive) return false;
            if (group.startAt && current < new Date(group.startAt).getTime()) return false;
            if (group.endAt && current > new Date(group.endAt).getTime()) return false;
            return $promoGroupItemsDB.some((item) => item.groupId === d.groupId && item.productId === productId);
        });
        if (!discount) return null;
        return {
            name: discount.name,
            price: discount.type === "percentage"
                ? Math.max(0, normalPrice - Math.round(normalPrice * discount.value / 100))
                : discount.value,
        };
    }

    let promoClock = new Date().toISOString();

    onMount(() => {
        const timer = setInterval(() => {
            promoClock = new Date().toISOString();
        }, 60000);

        // Auto-generate and cache till identity for this machine
        if (isTauri()) {
            getOrCreateTillId().then(async id => {
                tillId = id;
                await ensureTillReceiptSequence();
            });
            getTillName().then(name => { tillName = name; });
        } else {
            tillId = "browser-preview-till";
            tillName = "Browser Preview";
            if (!get(currentShiftId)) currentShiftId.set("browser-preview-shift");
        }
        document.addEventListener("pointerup", handlePosPointerUp);
        document.addEventListener("keydown", handleGlobalScannerKeydown, true);
        focusScannerSoon();

        return () => {
            clearInterval(timer);
            if (scannerFocusTimer) clearTimeout(scannerFocusTimer);
            clearScannerBuffer();
            document.removeEventListener("pointerup", handlePosPointerUp);
            document.removeEventListener("keydown", handleGlobalScannerKeydown, true);
        };
    });

    onDestroy(() => {
        stopScalePolling();
        if (cartScrollFrame) cancelAnimationFrame(cartScrollFrame);
    });

    let tillId = '';
    let tillName = 'Till 1';

    async function login() {
        if (!selectedLoginEmployeeId) {
            loginError = "Choose your user first";
            return;
        }
        try {
            const employee = await authenticateEmployeePin(selectedLoginEmployeeId, loginPin);
            if (!employee) {
                loginError = "Incorrect PIN for this user";
                loginPin = "";
                return;
            }
            await prepareEmployeeSession(employee);
            loginPin = "";
            loginError = "";
        } catch (error) {
            console.error("Could not sign in:", error);
            logout();
            loginPin = "";
            loginError = "Could not open this till shift. Check the database connection and try again.";
        }
    }

    async function prepareEmployeeSession(employee: Employee) {
        const registerId = tillId || await getOrCreateTillId();
        tillId = registerId;
        const cashUpActivationTime = $settingsDB.find((s) => s.key === "cash_up_activation_time")?.value || "";
        await retireOpenShiftsBefore(employee.id, registerId, cashUpActivationTime);
        const existingShiftId = (await findOpenShiftForRegister(registerId))?.id || null;
        const cashUpEnabled = ($settingsDB.find((s) => s.key === "cash_up_enabled")?.value ?? "false") === "true";
        const openingFloatRequired = ($settingsDB.find((s) => s.key === "cash_up_require_opening_float")?.value ?? "true") !== "false";
        if (!existingShiftId && cashUpEnabled && openingFloatRequired) {
            pendingShiftEmployee = employee;
            openingFloatString = "0";
            loginPin = "";
            loginError = "";
            return;
        }
        currentShiftId.set(existingShiftId || await ensureOpenShift(employee.id, registerId));
    }

    async function restoreLastEmployeeSession() {
        const employee = restoreRememberedEmployeeSession();
        if (!employee) return;
        restoringRememberedSession = true;
        try {
            await prepareEmployeeSession(employee);
            selectedLoginEmployeeId = "";
            loginPin = "";
            loginError = "";
        } catch (error) {
            console.error("Could not restore previous staff session:", error);
            logout();
            loginError = "Could not reopen the previous staff session. Sign in again.";
        } finally {
            restoringRememberedSession = false;
        }
    }

    async function openShiftWithFloat() {
        if (!pendingShiftEmployee) return;
        try {
            const registerId = tillId || await getOrCreateTillId();
            tillId = registerId;
            currentShiftId.set(await ensureOpenShift(
                pendingShiftEmployee.id,
                registerId,
                Math.max(0, parseInt(openingFloatString) || 0),
            ));
            pendingShiftEmployee = null;
            openingFloatString = "0";
            toast("Till shift opened", "success");
        } catch (error) {
            console.error("Could not open till shift:", error);
            toast("Could not open the till shift. Check the database connection and try again.", "error");
        }
    }

    function cancelOpeningShift() {
        pendingShiftEmployee = null;
        openingFloatString = "0";
        logout();
    }

    function chooseLoginEmployee(employeeId: string) {
        selectedLoginEmployeeId = employeeId;
        loginPin = "";
        loginError = "";
    }

    function logoutEmployee() {
        if (cart.length > 0) {
            toast("Complete or clear the current order before changing user", "error");
            return;
        }
        logout();
        selectedLoginEmployeeId = "";
        loginPin = "";
        loginError = "";
    }

    function moveSelectionUp() {
        if (selectedCartIndex > 0) selectedCartIndex--;
    }
    function moveSelectionDown() {
        if (selectedCartIndex < cart.length - 1) selectedCartIndex++;
    }

    $: if (cart.length === 0 && selectedCartIndex !== 0) selectedCartIndex = 0;
    $: if (cart.length > 0 && selectedCartIndex >= cart.length) selectedCartIndex = cart.length - 1;
    $: if (selectedCartIndex < 0) selectedCartIndex = 0;
    $: selectedCartItem = cart[selectedCartIndex];
    $: hasSelectedCartItem = Boolean(selectedCartItem);

    function sendCctvCartProductName(item: { name: string; price: number } | undefined) {
        if (!item) return;
        sendCctvItemAdded({
            name: item.name,
            price: item.price,
            quantity: 1,
            tillName,
            cashierName: $currentEmployee?.name || "",
        });
    }

    function increaseQty() {
        if (cart[selectedCartIndex]?.quantityLocked) return;
        if (cart[selectedCartIndex]) {
            if (cart[selectedCartIndex].quantity >= MAX_CART_QUANTITY) {
                toast(`Quantity cannot be more than ${MAX_CART_QUANTITY.toLocaleString()}`, "error");
                return;
            }
            cart[selectedCartIndex].quantity++;
            sendCctvCartProductName(cart[selectedCartIndex]);
        }
        cart = [...cart];
    }

    function decreaseQty() {
        if (cart[selectedCartIndex]?.quantityLocked) return;
        if (cart[selectedCartIndex] && cart[selectedCartIndex].quantity > 1) {
            cart[selectedCartIndex].quantity--;
            sendCctvCartProductName(cart[selectedCartIndex]);
            cart = [...cart];
        }
    }

    function openQuantityPad() {
        if (!cart[selectedCartIndex] || cart[selectedCartIndex].quantityLocked) return;
        showNumpad = true;
    }

    function handleNumpadKey(key: string) {
        if (key === "C") {
            numpadValue = "";
        } else if (key === "ENTER") {
            if (numpadValue !== "" && cart[selectedCartIndex] && !cart[selectedCartIndex].quantityLocked) {
                const quantity = parseInt(numpadValue);
                if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CART_QUANTITY) {
                    toast(`Quantity must be between 1 and ${MAX_CART_QUANTITY.toLocaleString()}`, "error");
                    return;
                }
                cart[selectedCartIndex].quantity = quantity;
                sendCctvCartProductName(cart[selectedCartIndex]);
                cart = [...cart];
            }
            showNumpad = false;
            numpadValue = "";
        } else if (numpadValue.length < 4) {
            numpadValue += key;
        }
    }

    function deleteSelected() {
        if (cart.length === 0) return;
        cart.splice(selectedCartIndex, 1);
        cart = [...cart];
        if (selectedCartIndex >= cart.length)
            selectedCartIndex = Math.max(0, cart.length - 1);
    }

    function deleteItem(index: number) {
        if (!cart[index]) return;
        cart.splice(index, 1);
        if (selectedCartIndex > index) selectedCartIndex--;
        cart = [...cart];
        if (selectedCartIndex >= cart.length)
            selectedCartIndex = Math.max(0, cart.length - 1);
    }

    function addToCart(product: {
        id: string;
        name: string;
        price: number;
        forceSeparateLine?: boolean;
        isPriceOverride?: boolean;
        originalPrice?: number;
        sourceBarcode?: string;
        quantityLocked?: boolean;
        skipStockAdjustment?: boolean;
        note?: string;
    }) {
        const existing = product.forceSeparateLine ? -1 : cart.findIndex((i) => i.id === product.id);
        if (existing >= 0) {
            if (cart[existing].quantity >= MAX_CART_QUANTITY) {
                toast(`Quantity cannot be more than ${MAX_CART_QUANTITY.toLocaleString()}`, "error");
                return;
            }
            cart[existing].quantity++;
            selectedCartIndex = existing;
        } else {
            cart.push({
                id: product.id,
                name: product.name,
                price: product.price,
                quantity: 1,
                note: product.note || "",
                isPriceOverride: product.isPriceOverride,
                originalPrice: product.originalPrice,
                sourceBarcode: product.sourceBarcode,
                quantityLocked: product.quantityLocked,
                skipStockAdjustment: product.skipStockAdjustment,
            });
            selectedCartIndex = cart.length - 1;
        }
        cart = [...cart];
        playItemAddedSound();
        sendCctvCartProductName({ name: product.name, price: product.price });
    }

    function scaleInputFromReading(reading: ScaleWeightReading): string {
        if (reading.unit === "g") {
            return String(Math.max(0, Math.round(reading.weight)));
        }
        return Math.max(0, reading.weight).toFixed(3).replace(/\.?0+$/, "") || "0";
    }

    function applyScaleReading(reading: ScaleWeightReading) {
        if (!Number.isFinite(reading.weight)) return;
        scaleWeightUnit = reading.unit;
        scaleWeightInput = scaleInputFromReading(reading);
        scaleReadStatus = `Live scale: ${formatScaleReading(reading)}`;
    }

    async function readScaleNow(showErrors = true) {
        if (!scaleHardwareReady) {
            const message = "Set the scale port in Printer Setup first";
            scaleReadStatus = message;
            if (showErrors) toast(message, "error");
            return;
        }
        if (scaleReadBusy) return;
        scaleReadBusy = true;
        try {
            const reading = await readScaleWeight(scaleHardwareConfig);
            applyScaleReading(reading);
        } catch (error) {
            const message = `Scale did not read: ${error}`;
            scaleReadStatus = message;
            if (showErrors) toast(message, "error");
        } finally {
            scaleReadBusy = false;
        }
    }

    function startScalePolling() {
        if (scalePollTimer) return;
        void readScaleNow(false);
        scalePollTimer = setInterval(() => void readScaleNow(false), scaleHardwareConfig.pollMs);
    }

    function stopScalePolling() {
        if (scalePollTimer) {
            clearInterval(scalePollTimer);
            scalePollTimer = undefined;
        }
    }

    function closeScaleModal() {
        showScaleModal = false;
        stopScalePolling();
        scalePollingSignature = "";
    }

    function productMatchesScaleSearch(product: Product, rawQuery: string): boolean {
        const q = rawQuery.trim().toLowerCase();
        if (!q) return true;
        return [product.name, product.sku, product.barcode, product.scalePlu]
            .some((value) => String(value || "").toLowerCase().includes(q));
    }

    function openScale() {
        selectedScaleProductId = "";
        scaleWeightInput = "";
        scaleWeightUnit = "kg";
        scaleSearch = "";
        scalePage = 0;
        scaleReadStatus = "";
        activeScaleTilePageId = scaleTilePages[0]?.id || "";
        showScaleModal = true;
    }

    function openScaleForProduct(productId: string) {
        scaleWeightInput = "";
        scaleWeightUnit = "kg";
        scaleSearch = "";
        scalePage = 0;
        scaleReadStatus = "";
        activeScaleTilePageId = scaleTilePages.find((page) => page.productIds.includes(productId))?.id || scaleTilePages[0]?.id || "";
        selectedScaleProductId = productId;
        showScaleModal = true;
    }

    function handleScaleKey(key: string) {
        const digitCount = scaleWeightInput.replace(/\D/g, "").length;
        if (key === "C") {
            scaleWeightInput = "";
        } else if (key === "⌫") {
            scaleWeightInput = scaleWeightInput.slice(0, -1);
        } else if (key === "." && !scaleWeightInput.includes(".")) {
            scaleWeightInput = scaleWeightInput ? `${scaleWeightInput}.` : "0.";
        } else if (/^\d$/.test(key)) {
            if (digitCount >= MAX_SCALE_WEIGHT_DIGITS) {
                toast("Scale weight is too large", "error");
                return;
            }
            scaleWeightInput += key;
        }
    }

    function addManualScaleItem() {
        if (!selectedScaleProduct || !Number.isFinite(scaleWeightKg) || !Number.isFinite(scaleLinePrice) || scaleWeightKg <= 0 || scaleLinePrice <= 0) {
            toast("Choose a weighable item and enter a valid weight", "error");
            return;
        }
        if (scaleLinePrice > MAX_ORDER_TOTAL_PENCE) {
            toast("Scale total is too large", "error");
            return;
        }
        const grams = Math.round(scaleWeightKg * 1000);
        addToCart({
            id: selectedScaleProduct.id,
            name: selectedScaleProduct.name,
            price: scaleLinePrice,
            originalPrice: selectedScaleProduct.price,
            isPriceOverride: true,
            forceSeparateLine: true,
            quantityLocked: true,
            skipStockAdjustment: true,
            note: `Manual scale: ${grams} g at ${formatMoney(selectedScaleProduct.price)}/kg`,
        });
        closeScaleModal();
        toast(`${selectedScaleProduct.name} added from scale`, "success");
    }

    async function handleSearch() {
        const query = searchQuery.trim();
        if (!query) return;
        // Clear immediately so a second fast scan cannot be overwritten when
        // this asynchronous lookup finishes.
        searchQuery = "";

        try {
            const found = productByBarcode.get(normalizeLookupCode(query)) || await searchProduct(query);

            if (found) {
                const product = normalizeProductForCache({ ...found, showInPos: true });
                rememberProductInPosCache(product);
                if (product.isWeighable) {
                    openScaleForProduct(product.id);
                    return;
                }
                addToCart({
                    id: product.id,
                    name: product.name,
                    price: product.price,
                });
                return;
            }
            const parsed = parseScaleBarcode(query, getBarcodeRules($settingsDB));
            if (parsed) {
                const scaleProduct = scaleProductByPlu.get(normalizeLookupCode(parsed.scalePlu)) || await searchProductByScalePlu(parsed.scalePlu);
                if (!scaleProduct) {
                    toast(`No active product has Scale PLU ${parsed.scalePlu}`, "error");
                    playErrorSound();
                    return;
                }
                const product = normalizeProductForCache({ ...scaleProduct, showInPos: true });
                rememberProductInPosCache(product);
                if (parsed.rule.valueType === "weight") {
                    const linePrice = Math.round(product.price * parsed.value);
                    if (linePrice <= 0) {
                        toast("Weight barcode contains an invalid weight", "error");
                        playErrorSound();
                        return;
                    }
                    addToCart({
                        id: product.id,
                        name: product.name,
                        price: linePrice,
                        originalPrice: product.price,
                        isPriceOverride: true,
                        sourceBarcode: parsed.rawBarcode,
                        note: `Scale weight barcode: ${Math.round(parsed.value * 1000)} g at ${formatMoney(product.price)}/kg`,
                        forceSeparateLine: true,
                        quantityLocked: true,
                        skipStockAdjustment: true,
                    });
                    return;
                }
                addToCart({
                    id: product.id,
                    name: product.name,
                    price: Math.round(parsed.value * 100),
                    originalPrice: product.price,
                    isPriceOverride: true,
                    sourceBarcode: parsed.rawBarcode,
                    note: `Scale price barcode: ${parsed.rawBarcode}`,
                    forceSeparateLine: true,
                    quantityLocked: true,
                    skipStockAdjustment: true,
                });
                return;
            }
            notFoundBarcode = query;
            showNotFoundModal = true;
            playErrorSound();
        } catch (error) {
            console.error("Product lookup failed:", error);
            toast("Could not search products. Please try scanning again.", "error");
            playErrorSound();
        }
    }

    function openQuickAdd() {
        showNotFoundModal = false;
        quickAddName = "";
        quickAddSku = "";
        quickAddPrice = "0";
        quickAddBusy = false;
        quickAddCategoryId =
            $activeCategories.length > 0 ? $activeCategories[0].id : "";
        quickAddTaxRateId =
            get(taxRatesDB).find((t: any) => t.isDefault)?.id || "tax-standard-vat";
        showQuickAddModal = true;
    }

    function handleQuickAddPriceKey(key: string) {
        if (key === "C") {
            quickAddPrice = "0";
        } else if (key === "00") {
            if (quickAddPrice !== "0" && quickAddPrice.length <= 7) quickAddPrice += "00";
        } else if (quickAddPrice.length < 9) {
            if (quickAddPrice === "0") quickAddPrice = key;
            else quickAddPrice += key;
        }
    }

    async function saveQuickProduct(printLabel = false) {
        if (quickAddBusy) return;
        if (!quickAddName.trim()) {
            toast("Item Name is required", "error");
            return;
        }
        const price = parseInt(quickAddPrice) || 0;
        if (price <= 0) {
            toast("Selling Price is required", "error");
            return;
        }
        if (!quickAddCategoryId) {
            toast("Category is required", "error");
            return;
        }

        const newProduct: Product = {
            id: uuid(),
            categoryId: quickAddCategoryId,
            taxRateId: quickAddTaxRateId || "tax-standard-vat",
            name: quickAddName.trim(),
            sku: quickAddSku.trim(),
            barcode: notFoundBarcode,
            scalePlu: "",
            price: price,
            costPrice: 0,
            stockLevel: 0,
            trackStock: false,
            isWeighable: false,
            showInGoods: false,
            goodsSortOrder: 0,
            color: "#6366f1",
            image: "",
            isActive: true,
            createdAt: now(),
            updatedAt: now(),
        };

        quickAddBusy = true;
        try {
            await addProduct(newProduct);
            productsDB.update((ps) => [...ps, newProduct]);
            addToCart(newProduct);
            showQuickAddModal = false;
            if (printLabel) {
                try {
                    const labelPrinter = getLabelPrinterConfig($settingsDB);
                    await printProductLabels({
                        product: newProduct,
                        store: $storeDB,
                        design: getLabelDesign($settingsDB),
                        quantity: 1,
                    }, labelPrinter);
                    toast("Product added and label sent to printer", "success");
                } catch (printError) {
                    toast(`Product added, but label did not print: ${String(printError).replace(/^Error:\s*/, "")}`, "error");
                }
            } else {
                toast("Product added and added to cart", "success");
            }
        } catch (error) {
            toast(String(error).replace(/^Error:\s*/, ""), "error");
        } finally {
            quickAddBusy = false;
        }
    }
    function handleSearchKeydown(e: KeyboardEvent) {
        if (e.key === "Enter") handleSearch();
    }

    function handlePosBackgroundClick(event: MouseEvent) {
        const element = event.target as Element | null;
        if (!element || scannerFocusBlocked()) return;
        if (element.closest("button, input, textarea, select, a, [role='button'], [contenteditable='true'], .cursor-pointer")) return;
        focusScannerSoon(true);
    }

    function confirmClear() {
        cart = [];
        selectedCartIndex = 0;
        showClearConfirm = false;
        showTrolleyFeedback("Cart cleared", "success");
    }

    async function holdOrder() {
        if (isHoldingOrder) return;
        if (cart.length === 0) {
            toast("Cart is empty", "error");
            return;
        }
        if (!$currentEmployee || !$currentShiftId || !tillId) {
            toast("This till has no active signed-in shift. Sign in again before holding an order.", "error");
            return;
        }
        const orderId = uuid();
        const timestamp = now();
        const firstPromoId =
            cartEval.lines
                .flatMap((l) => l.applied)
                .map((a) => a.discountId)[0] || "";
        const newOrder = {
            id: orderId,
            shiftId: $currentShiftId,
            customerId: "",
            employeeId: $currentEmployee?.id || "",
            orderNumber: 0,
            type: "sale" as const,
            status: "hold" as const,
            originalOrderId: "",
            subtotal,
            discountId: selectedManualDiscountId || firstPromoId,
            discountAmount: promoSavings,
            taxTotal: 0,
            total,
            tillNumber: tillId,
            notes: "",
            paymentMethod: "",
            amountTendered: 0,
            createdAt: timestamp,
            completedAt: "",
            updatedAt: timestamp,
        };
        const lines = cart.map((item, i) => {
            const ev = cartEval.lines[i];
            const lineDiscount = ev?.savings || 0;
            const lineDiscountId = ev?.applied?.[0]?.discountId || "";
            return {
                id: uuid(),
                orderId,
                productId: item.id,
                productName: item.name,
                quantity: item.quantity,
                unitPrice: item.price,
                costPrice: 0,
                discountId: lineDiscountId,
                discountAmount: lineDiscount,
                taxRate: 0,
                taxAmount: 0,
                lineTotal: item.price * item.quantity - lineDiscount,
                isPriceOverride: item.isPriceOverride || false,
                originalPrice: item.originalPrice ?? item.price,
                notes: item.note,
                updatedAt: timestamp,
            };
        });
        try {
            isHoldingOrder = true;
            await upsert("orders", newOrder);
            for (const line of lines) await upsert("order_lines", line);
            if (!newOrder.tillNumber || newOrder.tillNumber === tillId) {
                heldOrdersForTill = [enrichOrderSummary(newOrder as Order), ...heldOrdersForTill];
                heldOrderLinesByOrder = new Map(heldOrderLinesByOrder).set(orderId, lines as OrderLine[]);
            }
            cart = [];
            selectedCartIndex = 0;
            toast("Receipt held successfully");
        } catch (error) {
            try {
                await removeSql("orders", orderId);
            } catch (cleanupError) {
                console.error("Could not clean up failed held order:", cleanupError);
            }
            console.error("Could not hold order:", error);
            toast("Could not hold this order. The trolley has been kept.", "error");
        } finally {
            isHoldingOrder = false;
        }
    }

    async function retrieveOrder(orderId: string) {
        if (cart.length > 0) {
            toast(
                "Cannot retrieve while trolley has items. Please clear trolley first.",
                "error",
            );
            return;
        }
        const heldOrder = heldOrdersForTill.find((order) => order.id === orderId);
        const lines = heldOrderLinesByOrder.get(orderId) || [];
        if (lines.length === 0) {
            toast("This held order has no item lines. Sync and try again.", "error");
            return;
        }
        const restoredCart = lines.map((l) => ({
            id: l.productId,
            name: l.productName,
            price: l.unitPrice,
            quantity: l.quantity,
            note: l.notes,
            isPriceOverride: l.isPriceOverride,
            originalPrice: l.originalPrice,
            quantityLocked: l.notes?.startsWith("Scale price barcode:") || l.notes?.startsWith("Scale weight barcode:") || l.notes?.startsWith("Manual scale:") || false,
            skipStockAdjustment: l.notes?.startsWith("Scale price barcode:") || l.notes?.startsWith("Scale weight barcode:") || l.notes?.startsWith("Manual scale:") || false,
        }));
        // Cascade delete in SQLite (order_lines.orderId has ON DELETE CASCADE).
        try {
            await removeSql("orders", orderId);
        } catch (e) {
            console.error(e);
            toast("Could not retrieve the held order. Try again.", "error");
            return;
        }
        cart = restoredCart;
        selectedManualDiscountId = $discountsDB.some((discount) =>
            discount.id === heldOrder?.discountId && discount.kind === "manual_percent" && discount.isActive
        ) ? heldOrder!.discountId : "";
        selectedCartIndex = 0;
        heldOrdersForTill = heldOrdersForTill.filter((order) => order.id !== orderId);
        const nextHeldLines = new Map(heldOrderLinesByOrder);
        nextHeldLines.delete(orderId);
        heldOrderLinesByOrder = nextHeldLines;
        showHeldOrders = false;
        toast("Order retrieved");
    }

    function openChangePrice() {
        if (cart[selectedCartIndex]) {
            const product = $productsDB.find((item) => item.id === cart[selectedCartIndex].id);
            if (!product?.allowPriceOverride && !hasPermission($currentEmployee, "price_override", $settingsDB)) {
                void requirePermission(
                    "price_override",
                    "Override item price",
                    () => showChangePricePadForSelected(),
                    "product",
                    product?.id || cart[selectedCartIndex].id,
                    `Temporary price override for ${cart[selectedCartIndex].name}`,
                );
                return;
            }
            showChangePricePadForSelected();
        }
    }

    function showChangePricePadForSelected() {
        if (!cart[selectedCartIndex]) return;
        changePriceString = cart[selectedCartIndex].price.toString();
        hasStartedTypingPrice = false;
        showChangePricePad = true;
    }

    function handleChangePriceKey(key: string) {
        if (key === "C") {
            changePriceString = "0";
            hasStartedTypingPrice = true;
        } else if (key === "00") {
            if (!hasStartedTypingPrice) {
                changePriceString = "0";
                hasStartedTypingPrice = true;
            }
            if (changePriceString !== "0" && changePriceString.length <= 7) changePriceString += "00";
        } else if (changePriceString.length < 9) {
            if (!hasStartedTypingPrice || changePriceString === "0") {
                changePriceString = key;
                hasStartedTypingPrice = true;
            } else {
                changePriceString += key;
            }
        }
    }

    function changePriceOnce() {
        const newPence = parseInt(changePriceString) || 0;
        if (newPence <= 0) {
            toast("Item price must be greater than £0.00", "error");
            return;
        }
        if (cart[selectedCartIndex]) {
            cart[selectedCartIndex] = {
                ...cart[selectedCartIndex],
                price: newPence,
            };
            cart = [...cart];
        }
        showChangePricePad = false;
        changePriceString = "";
    }

    async function changePricePermanently() {
        await performPermanentPriceChange(false);
    }

    async function performPermanentPriceChange(approvedByManager: boolean) {
        if (!approvedByManager && !hasPermission($currentEmployee, "price_override", $settingsDB)) {
            await requirePermission(
                "price_override",
                "Change item price permanently",
                () => performPermanentPriceChange(true),
                "product",
                cart[selectedCartIndex]?.id || "",
                `Permanent price change for ${cart[selectedCartIndex]?.name || "item"}`,
            );
            return;
        }
        const newPence = parseInt(changePriceString) || 0;
        if (newPence <= 0) {
            toast("Permanent item price must be greater than £0.00", "error");
            return;
        }
        if (cart[selectedCartIndex]) {
            const updatedItem = { ...cart[selectedCartIndex], price: newPence };
            const product = $productsDB.find((item) => item.id === updatedItem.id);
            if (!product) {
                toast("This item is no longer available", "error");
                return;
            }
            try {
                await updateProductFields(
                    { id: updatedItem.id, price: newPence },
                    { price: product.price },
                );
                cart[selectedCartIndex] = updatedItem;
                productsDB.update((items) => items.map((item) =>
                    item.id === updatedItem.id ? { ...item, price: newPence, updatedAt: now() } : item,
                ));
                cart = [...cart];
                toast("Price updated permanently");
            } catch (error) {
                toast(`Could not update price: ${String(error).replace(/^Error:\s*/, "")}`, "error");
                return;
            }
        }
        showChangePricePad = false;
        changePriceString = "";
    }

    function openGoodsModal() {
        goodsPriceString = "0";
        goodsSearchQuery = "";
        showGoodsModal = true;
    }

    function handleGoodsPadKey(key: string) {
        if (key === "C") {
            goodsPriceString = "0";
        } else if (key === "00") {
            if (goodsPriceString !== "0" && goodsPriceString.length <= 7) goodsPriceString += "00";
        } else if (goodsPriceString.length < 9) {
            if (goodsPriceString === "0") goodsPriceString = key;
            else goodsPriceString += key;
        }
    }

    function addGoodsItem(product: any) {
        const newPence = parseInt(goodsPriceString) || 0;
        if (newPence <= 0) {
            toast("Please enter a price", "error");
            return;
        }

        cart.push({
            id: product.id,
            name: product.name,
            price: newPence,
            quantity: 1,
            note: "",
        });
        selectedCartIndex = cart.length - 1;
        cart = [...cart];
        playItemAddedSound();

        showGoodsModal = false;
        goodsPriceString = "0";
    }
    let heldOrdersForTill: PosOrderSummary[] = [];
    let heldOrderLinesByOrder = new Map<string, OrderLine[]>();
    let heldOrdersLoading = false;
    let posSummaryTillKey = "";
    let posSummaryLoadToken = 0;
    let latestTillReceiptOrder: PosOrderSummary | null = null;

    function groupLinesByOrderId(lines: OrderLine[]): Map<string, OrderLine[]> {
        const grouped = new Map<string, OrderLine[]>();
        for (const line of lines) {
            const existing = grouped.get(line.orderId) || [];
            existing.push(line);
            grouped.set(line.orderId, existing);
        }
        return grouped;
    }

    function enrichOrderSummary(order: Order): PosOrderSummary {
        return {
            ...order,
            cashierName: employeeById.get(order.employeeId)?.name || "",
            tillName: registerById.get(order.tillNumber)?.name || tillName || order.tillNumber || "",
            customerName: $customersDB.find((customer) => customer.id === order.customerId)?.name || "",
        };
    }

    async function refreshPosOrderSummaries() {
        if (!tillId) return;
        const token = ++posSummaryLoadToken;
        heldOrdersLoading = true;
        try {
            const [heldResult, latestReceipt] = await Promise.all([
                getPosHeldOrders(tillId),
                getLatestTillReceipt(tillId),
            ]);
            if (token !== posSummaryLoadToken) return;
            heldOrdersForTill = heldResult.orders as PosOrderSummary[];
            heldOrderLinesByOrder = groupLinesByOrderId(heldResult.lines as OrderLine[]);
            latestTillReceiptOrder = latestReceipt as PosOrderSummary | null;
        } catch (error) {
            console.warn("Could not refresh POS order summaries:", error);
        } finally {
            if (token === posSummaryLoadToken) heldOrdersLoading = false;
        }
    }

    $: if (tillId && tillId !== posSummaryTillKey) {
        posSummaryTillKey = tillId;
        void refreshPosOrderSummaries();
    }
    $: isMenuDisabled = cart.length > 0 || heldOrdersForTill.length > 0;

    function handleMenuClick(path: string) {
        if (isMenuDisabled) {
            const msg =
                cart.length > 0
                    ? "You have products in the trolley"
                    : "You have held orders";
            toast(msg, "error");
            return;
        }
        if ($employeesDB.length === 0) {
            goto("/setup");
            return;
        }
        const permissionByPath: Record<string, PermissionKey> = {
            "/design": "open_design",
            "/tiles": "open_design",
            "/items": "open_items",
            "/categories": "open_items",
            "/customers": "open_items",
            "/suppliers": "open_items",
            "/tax-rates": "open_items",
            "/discounts": "open_discounts",
            "/employees": "open_employees",
            "/reports": "open_reports",
            "/settings": "open_settings",
            "/sync": "open_sync",
            "/audit": "open_audit",
            "/stock-receiving": "open_stock_receiving",
        };
        const permission = permissionByPath[path];
        if (permission && !hasPermission($currentEmployee, permission, $settingsDB)) {
            void requirePermission(permission, `Open ${permissionLabels[permission]}`, () => goto(path), "page", path);
            return;
        }
        goto(path);
    }

    let showRecentTransactions = false;
    let selectedRecentOrderId: string | null = null;
    let lastReceiptPrinting = false;
    let recentTransactionsLoading = false;
    let recentOrders: PosOrderSummary[] = [];
    let recentOrderLinesByOrder = new Map<string, OrderLine[]>();
    let recentLoadToken = 0;
    const RECENT_RECEIPT_LIMIT = 10;
    $: scannerOverlayOpen =
        showNumpad ||
        showChangePricePad ||
        showGoodsModal ||
        showHeldOrders ||
        showPaymentModal ||
        showDiscountModal ||
        showNotFoundModal ||
        showQuickAddModal ||
        showScaleModal ||
        showClearConfirm ||
        showReversalConfirm ||
        showPartialRefundPad ||
        showRecentTransactions ||
        isHoldingOrder ||
        isCompletingSale;
    $: if (!scannerOverlayOpen && $currentEmployee) focusScannerSoon();
    $: receiptDesign = getReceiptDesign($settingsDB);

    $: if (
        showRecentTransactions &&
        selectedRecentOrderId &&
        !recentOrders.some((order) => order.id === selectedRecentOrderId)
    ) {
        selectedRecentOrderId = recentOrders[0]?.id || null;
    }

    async function refreshRecentReceipts() {
        const token = ++recentLoadToken;
        recentTransactionsLoading = true;
        try {
            const result = await getPosRecentReceipts(RECENT_RECEIPT_LIMIT);
            if (token !== recentLoadToken) return;
            recentOrders = result.orders as PosOrderSummary[];
            recentOrderLinesByOrder = groupLinesByOrderId(result.lines as OrderLine[]);
            selectedRecentOrderId = recentOrders[0]?.id || null;
        } catch (error) {
            console.warn("Could not load recent receipts:", error);
            toast(`Could not load recent receipts: ${String(error).replace(/^Error:\s*/, "")}`, "error");
        } finally {
            if (token === recentLoadToken) recentTransactionsLoading = false;
        }
    }

    async function openRecentTransactions() {
        showRecentTransactions = true;
        await refreshRecentReceipts();
        if ($connectionState.mode === "multi" && $connectionState.mysqlOnline) {
            void triggerSync().catch((e) => {
                console.warn("Failed to refresh recent transactions in background:", e);
            });
        }
    }

    function getCachedReceiptLines(orderId: string): OrderLine[] {
        return recentOrderLinesByOrder.get(orderId) || heldOrderLinesByOrder.get(orderId) || [];
    }

    async function getReceiptLines(orderId: string): Promise<OrderLine[]> {
        const cached = getCachedReceiptLines(orderId);
        if (cached.length > 0) return cached;
        const details = await getOrderDetails(orderId);
        return details.lines as OrderLine[];
    }

    async function printStoredReceipt(selectedOrder: any, successMessage = "Receipt sent to printer") {
        if (receiptPrinterConfig.connection === "system") {
            toast("Set Receipt Printer to USB raw, Network, Serial, or Bluetooth first", "error");
            return;
        }
        try {
            const receiptLines = await getReceiptLines(selectedOrder.id);
            await printEscposReceipt({
                store: $storeDB,
                order: selectedOrder,
                lines: receiptLines.map((line) => ({
                    ...line,
                    sku: productById.get(line.productId)?.sku || "",
                })),
                cashierName: selectedOrder.cashierName || employeeById.get(selectedOrder.employeeId)?.name || "",
                tillName: selectedOrder.tillName || registerById.get(selectedOrder.tillNumber)?.name || tillName,
                design: receiptDesign,
            }, receiptPrinterConfig);
            toast(successMessage, "success");
        } catch (error) {
            toast(`Receipt did not print: ${error}`, "error");
        }
    }

    async function printReceipt() {
        if (!selectedRecentOrderId || !recentOrders.some((order) => order.id === selectedRecentOrderId)) {
            toast("Select a receipt before printing", "error");
            return;
        }
        const selectedOrder = recentOrders.find((order) => order.id === selectedRecentOrderId);
        if (!selectedOrder) return;
        await printStoredReceipt(selectedOrder);
    }

    async function printLastTillReceipt() {
        if (lastReceiptPrinting) return;
        if (!tillId) {
            toast("This till is still loading. Try again in a moment.", "error");
            return;
        }
        if (!latestTillReceiptOrder) {
            toast("No receipt found for this till", "error");
            return;
        }
        lastReceiptPrinting = true;
        try {
            await printStoredReceipt(latestTillReceiptOrder, "Last receipt sent to printer");
        } finally {
            lastReceiptPrinting = false;
        }
    }

    async function printCompletedSaleReceipt(bundle: SaleBundle) {
        if (receiptPrinterConfig.connection === "system") {
            toast("Set Receipt Printer to USB raw, Network, Serial, or Bluetooth first", "error");
            return;
        }
        try {
            await printEscposReceipt({
                store: $storeDB,
                order: bundle.order,
                lines: bundle.lines.map((line) => ({
                    ...line,
                    sku: line.sku || productById.get(line.productId)?.sku || "",
                })),
                cashierName: employeeById.get(bundle.order.employeeId)?.name || $currentEmployee?.name || "",
                tillName: registerById.get(bundle.order.tillNumber)?.name || tillName,
                design: receiptDesign,
            }, receiptPrinterConfig);
            toast("Receipt sent to printer", "success");
        } catch (error) {
            toast(`Receipt did not print: ${error}`, "error");
        }
    }

    async function handleOpenCashDrawer() {
        if (drawerBusy) return;
        if (!cashDrawerTarget) {
            toast("Set the receipt printer in Settings first", "error");
            return;
        }
        drawerBusy = true;
        try {
            await openCashDrawer(cashDrawerConfig);
            toast("Drawer opened");
        } catch (error) {
            toast(`Drawer failed: ${error}`, "error");
        } finally {
            drawerBusy = false;
        }
    }

    async function openDrawerAfterSuccessfulPayment() {
        if (!receiptPrinterConfig.openDrawerAfterPayment) return;
        try {
            await openCashDrawer(cashDrawerConfig);
        } catch (error) {
            console.warn("Drawer failed after payment:", error);
            toast(`Sale completed, but drawer did not open: ${error}`, "error");
        }
    }

    async function printReceiptAfterSuccessfulPayment(bundle: SaleBundle) {
        if (!receiptPrinterConfig.autoPrintAfterPayment) return;
        try {
            await sendEscposReceipt({
                store: $storeDB,
                order: bundle.order,
                lines: bundle.lines,
                cashierName: $currentEmployee?.name || "",
                tillName,
                design: receiptDesign,
            }, receiptPrinterConfig);
        } catch (error) {
            console.warn("Receipt auto-print failed:", error);
            toast(`Sale completed, but receipt did not print: ${error}`, "error");
        }
    }

    async function reverseOrder(orderId: string, partial: boolean, voiding: boolean, approvedByManager = false) {
        if (isReversingOrder) return;
        if (!approvedByManager && !hasPermission($currentEmployee, "refund_void", $settingsDB)) {
            await requirePermission(
                "refund_void",
                voiding ? "Void sale" : partial ? "Partial refund" : "Refund sale",
                () => reverseOrder(orderId, partial, voiding, true),
                "order",
                orderId,
            );
            return;
        }
        const reversalContext = await getOrderReversalContext(orderId);
        const original = reversalContext.original as Order | null;
        if (!original || original.type === "return" || !["completed", "partially_refunded"].includes(original.status)) {
            toast("Only completed or partially refunded sales can be reversed", "error");
            return;
        }
        const originalLines = reversalContext.originalLines as OrderLine[];
        const originalPayments = reversalContext.originalPayments as Payment[];
        if (originalLines.length === 0 || originalPayments.length === 0) {
            toast("This transaction is incomplete on this till. Sync and try again.", "error");
            return;
        }
        const originalLoyaltyChanges = reversalContext.originalLoyaltyChanges;
        const previousReversals = reversalContext.previousReversals as Order[];
        const previousReversalPayments = reversalContext.previousReversalPayments as Payment[];
        const previousLoyaltyAdjustments = reversalContext.previousLoyaltyAdjustments;
        const remainingRefund = getRemainingRefundAmount(original.total, previousReversals);
        if (remainingRefund <= 0) {
            toast("This sale has already been fully refunded", "error");
            return;
        }
        if (voiding && original.status !== "completed") {
            toast("A partially refunded sale cannot be voided", "error");
            return;
        }
        let refundAmount = remainingRefund;
        if (partial) {
            refundAmount = toPence(Number(partialRefundInput));
            if (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount >= remainingRefund) {
                toast("Enter a valid partial refund smaller than the remaining amount", "error");
                return;
            }
        }
        const cumulativeRefund = original.total - remainingRefund + refundAmount;
        const previousSubtotal = previousReversals.reduce((sum, order) => sum + Math.abs(Math.min(0, order.subtotal)), 0);
        const previousDiscount = previousReversals.reduce((sum, order) => sum + Math.abs(Math.min(0, order.discountAmount)), 0);
        const previousTax = previousReversals.reduce((sum, order) => sum + Math.abs(Math.min(0, order.taxTotal)), 0);
        const refundSubtotal = Math.max(0, Math.round(original.subtotal * cumulativeRefund / original.total) - previousSubtotal);
        const refundDiscount = Math.max(0, Math.round(original.discountAmount * cumulativeRefund / original.total) - previousDiscount);
        const refundTax = Math.max(0, Math.round(original.taxTotal * cumulativeRefund / original.total) - previousTax);
        const timestamp = now();
        const reversalId = uuid();
        const status = voiding ? "voided" : refundAmount < remainingRefund ? "partially_refunded" : "refunded";
        const reversalOrder = {
            ...original,
            id: reversalId,
            orderNumber: 0,
            receiptKey: "",
            type: "return" as const,
            status: "completed" as const,
            originalOrderId: original.id,
            subtotal: -refundSubtotal,
            discountAmount: -refundDiscount,
            taxTotal: -refundTax,
            total: -refundAmount,
            amountTendered: -refundAmount,
            employeeId: $currentEmployee?.id || "",
            shiftId: $currentShiftId,
            tillNumber: tillId,
            notes: voiding ? `Void of receipt ${original.orderNumber}` : `Refund of receipt ${original.orderNumber}`,
            createdAt: timestamp,
            completedAt: timestamp,
            updatedAt: timestamp,
        };
        const lineAllocations = allocateRefundLines(refundAmount, refundDiscount, refundTax, originalLines);
        const reversalLines = originalLines.map((line, index) => {
            const allocation = lineAllocations[index];
            return {
                ...line,
                id: uuid(),
                orderId: reversalId,
                // A partial refund is amount-based, not an item return. Attribute
                // its revenue to the products without inventing a returned quantity.
                quantity: partial ? 0 : -line.quantity,
                discountAmount: -allocation.discountAmount,
                taxAmount: -allocation.taxAmount,
                lineTotal: -allocation.lineTotal,
                isPriceOverride: Boolean(line.isPriceOverride),
                notes: partial ? `${line.notes ? `${line.notes} · ` : ''}Proportional partial refund` : line.notes,
                updatedAt: timestamp,
            };
        });
        const paymentAllocation = allocateRefundPayment(refundAmount, originalPayments, previousReversalPayments);
        const payment = {
            id: uuid(),
            orderId: reversalId,
            method: paymentAllocation.method,
            amount: -refundAmount,
            cashAmount: -paymentAllocation.cashAmount,
            cardAmount: -paymentAllocation.cardAmount,
            reference: voiding ? "VOID" : "REFUND",
            changeGiven: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        reversalOrder.paymentMethod = paymentAllocation.method;
        const originalStockMovements = reversalContext.originalStockMovements;
        const stockChanges = partial ? [] : originalStockMovements.map((soldMovement) => ({
                productId: soldMovement.productId,
                delta: Math.abs(soldMovement.quantityChange),
                logId: uuid(),
                employeeId: $currentEmployee?.id || "",
                notes: `${voiding ? 'Void' : 'Refund'} receipt ${original.orderNumber}`,
                movementType: "return",
            }));
        const originalPointsChange = originalLoyaltyChanges.reduce((sum, entry) => sum + entry.pointsChange, 0);
        const previousPointsAdjustment = previousLoyaltyAdjustments.reduce((sum, entry) => sum + entry.pointsChange, 0);
        const pointsChange = -Math.round(originalPointsChange * cumulativeRefund / original.total) - previousPointsAdjustment;
        const loyaltyChanges = pointsChange === 0 || !original.customerId ? [] : [{
                id: uuid(),
                customerId: original.customerId,
                orderId: reversalId,
                pointsChange,
                reason: "refund_adjustment",
                createdAt: timestamp,
            }];
        try {
            isReversingOrder = true;
            const committedReversal = await commitSale({
                order: reversalOrder,
                lines: reversalLines,
                payment,
                stockChanges,
                loyaltyChanges,
                audit: {
                    id: uuid(),
                    employeeId: $currentEmployee?.id || "",
                    action: voiding ? "order_voided" : partial ? "order_partially_refunded" : "order_refunded",
                    entityType: "order",
                    entityId: original.id,
                    oldData: JSON.stringify({ status: original.status }),
                    newData: JSON.stringify({ status, refundAmount, reversalId }),
                    createdAt: timestamp,
                },
                originalOrderToUpdate: original.id,
                originalStatusUpdate: status,
            });
            applyCompletedSaleToStores(committedReversal);
            await refreshPosOrderSummaries();
            toast(voiding ? "Order voided and reversed" : "Refund recorded", "success");
            await openRecentTransactions();
        } catch (e) {
            toast(`Reversal failed: ${e}`, "error");
        } finally {
            isReversingOrder = false;
            pendingReversal = null;
            partialRefundInput = "";
            showReversalConfirm = false;
            showPartialRefundPad = false;
        }
    }

    function requestReversal(orderId: string, partial: boolean, voiding: boolean) {
        if (!hasPermission($currentEmployee, "refund_void", $settingsDB)) {
            void requirePermission(
                "refund_void",
                voiding ? "Void sale" : partial ? "Partial refund" : "Refund sale",
                () => beginReversal(orderId, partial, voiding, true),
                "order",
                orderId,
            );
            return;
        }
        beginReversal(orderId, partial, voiding, false);
    }

    function beginReversal(orderId: string, partial: boolean, voiding: boolean, approved = false) {
        pendingReversal = { orderId, partial, voiding, approved };
        partialRefundInput = "";
        if (partial) showPartialRefundPad = true;
        else showReversalConfirm = true;
    }

    async function reviewPartialRefund() {
        if (!pendingReversal) return;
        const reversalContext = await getOrderReversalContext(pendingReversal.orderId);
        const original = reversalContext.original as Order | null;
        if (!original) {
            toast("The original sale is no longer available", "error");
            return;
        }
        const previousReversals = reversalContext.previousReversals as Order[];
        const remaining = getRemainingRefundAmount(original.total, previousReversals);
        const amount = toPence(Number(partialRefundInput));
        if (!Number.isInteger(amount) || amount <= 0 || amount >= remaining) {
            toast(`Enter an amount smaller than ${formatMoney(remaining)}`, "error");
            return;
        }
        showPartialRefundPad = false;
        showReversalConfirm = true;
    }

    async function confirmPendingReversal() {
        if (!pendingReversal) return;
        await reverseOrder(pendingReversal.orderId, pendingReversal.partial, pendingReversal.voiding, pendingReversal.approved);
    }

    let nextPoundAmount: number | null = null;
    const fixedQuickAmounts = [500, 1000, 2000, 5000];

    function calculateQuickAmounts(tPence: number) {
        let nextPound = Math.ceil(tPence / 100) * 100;
        nextPoundAmount = nextPound > tPence ? nextPound : null;
    }

    $: if (showPaymentModal && !hasTypedPayment) {
        calculateQuickAmounts(paymentDue);
    }

    function openPayment() {
        if (cart.length === 0) {
            toast("Cart is empty", "error");
            return;
        }
        amountTenderedString = "0";
        paymentMethod = "cash";
        hasTypedPayment = false;
        customerSearch = "";
        selectedCustomerId = "";
        useLoyaltyCredit = false;
        calculateQuickAmounts(total);
        showPaymentModal = true;
        tick().then(() => customerSearchInput?.focus({ preventScroll: true }));
    }

    function closePayment() {
        if (isCompletingSale) return;
        showPaymentModal = false;
    }

    function selectPaymentCustomer(customer: Customer) {
        selectedCustomerId = customer.id;
        customerSearch = "";
        document.dispatchEvent(new Event("close-touch-keyboard"));
        useLoyaltyCredit = false;
        amountTenderedString = "0";
        hasTypedPayment = false;
        calculateQuickAmounts(total);
    }

    function handleCustomerSearchKeydown(event: KeyboardEvent) {
        if (event.key !== "Enter") return;
        const exact = $customersDB.find((customer) =>
            customer.loyaltyCode?.toLowerCase() === customerSearch.trim().toLowerCase(),
        );
        if (exact) selectPaymentCustomer(exact);
    }

    function toggleLoyaltyCredit() {
        if (!loyaltyRedemptionAvailable) {
            toast("Loyalty credit can only be redeemed while the shared database is online", "error");
            return;
        }
        const enabling = !useLoyaltyCredit;
        useLoyaltyCredit = enabling;
        amountTenderedString = "0";
        hasTypedPayment = false;
        calculateQuickAmounts(enabling ? Math.max(0, total - Math.min(total, availableLoyaltyCredit)) : total);
    }

    function removePaymentCustomer() {
        selectedCustomerId = "";
        useLoyaltyCredit = false;
        amountTenderedString = "0";
        hasTypedPayment = false;
        calculateQuickAmounts(total);
    }

    function handlePaymentPadKey(key: string) {
        if (key === "C") {
            amountTenderedString = "0";
            hasTypedPayment = true;
        } else if (key === "⌫") {
            if (amountTenderedString.length > 1)
                amountTenderedString = amountTenderedString.slice(0, -1);
            else amountTenderedString = "0";
            hasTypedPayment = true;
        } else if (key === "00") {
            if (!hasTypedPayment) {
                amountTenderedString = "0";
                hasTypedPayment = true;
            } else if (amountTenderedString !== "0" && amountTenderedString.length <= 7)
                amountTenderedString += "00";
        } else if (amountTenderedString.length < 9) {
            if (!hasTypedPayment || amountTenderedString === "0") {
                amountTenderedString = key;
                hasTypedPayment = true;
            } else amountTenderedString += key;
        }
    }

    async function setAmountAndComplete(amount: number) {
        if (isCompletingSale) return;
        amountTenderedString = amount.toString();
        hasTypedPayment = true;
        await tick();
        await completeSale();
    }

    async function addQuickAmount(amount: number) {
        if (isCompletingSale) return;
        if (!hasTypedPayment || amountTenderedString === "0") {
            amountTenderedString = "0";
            hasTypedPayment = true;
        }
        const nextAmount = (parseInt(amountTenderedString) || 0) + amount;
        if (nextAmount > MAX_ORDER_TOTAL_PENCE) {
            toast("Payment amount is too large", "error");
            return;
        }
        amountTenderedString = nextAmount.toString();
        if (paymentMethod === "cash" && nextAmount >= paymentDue) {
            await tick();
            await completeSale();
        }
    }

    function selectPaymentMethod(method: "cash" | "card") {
        if (isCompletingSale) return;
        paymentMethod = method;
        if (method === "card" && paymentInputAmount >= paymentDue) {
            amountTenderedString = "0";
            hasTypedPayment = false;
        }
    }

    function clearPaymentInput() {
        if (isCompletingSale) return;
        amountTenderedString = "0";
        hasTypedPayment = false;
    }

    function applyCompletedSaleToStores(bundle: SaleBundle) {
        const order = bundle.order;
        ordersDB.update((list) => [
            ...list.filter((existing) => existing.id !== order.id),
            order,
        ]);
        orderLinesDB.update((list) => [
            ...list.filter((existing) => existing.orderId !== order.id),
            ...bundle.lines,
        ]);
        paymentsDB.update((list) => [
            ...list.filter((existing) => existing.orderId !== order.id),
            bundle.payment,
        ]);
        inventoryLogDB.update((list) => [
            ...list,
            ...bundle.stockChanges.map((change) => ({
                id: change.logId,
                productId: change.productId,
                quantityChange: change.delta,
                type: (change.movementType || "sale") as "sale" | "return" | "restock" | "adjustment" | "waste",
                referenceId: order.id,
                employeeId: change.employeeId,
                notes: change.notes,
                createdAt: order.completedAt,
                updatedAt: order.updatedAt,
            })),
        ]);
        if (bundle.stockChanges.length > 0) {
            const deltas = new Map<string, number>();
            for (const change of bundle.stockChanges) {
                deltas.set(change.productId, (deltas.get(change.productId) || 0) + change.delta);
            }
            productsDB.update((list) => list.map((product) => {
                const delta = deltas.get(product.id);
                return delta
                    ? { ...product, stockLevel: (product.stockLevel || 0) + delta, updatedAt: order.updatedAt }
                    : product;
            }));
        }
        if (bundle.loyaltyChanges?.length) {
            loyaltyLogDB.update((list) => [
                ...list,
                ...bundle.loyaltyChanges!.map((change) => ({
                    ...change,
                    reason: change.reason as "earned" | "redeemed" | "manual_adjustment" | "refund_adjustment",
                    updatedAt: order.updatedAt,
                })),
            ]);
            const loyaltyDeltas = new Map<string, number>();
            for (const change of bundle.loyaltyChanges) {
                loyaltyDeltas.set(change.customerId, (loyaltyDeltas.get(change.customerId) || 0) + change.pointsChange);
            }
            customersDB.update((list) => list.map((customer) => {
                const delta = loyaltyDeltas.get(customer.id);
                return delta
                    ? { ...customer, loyaltyPoints: (customer.loyaltyPoints || 0) + delta, updatedAt: order.updatedAt }
                    : customer;
            }));
        }
        auditLogDB.update((list) => [...list, bundle.audit]);
        if (bundle.originalOrderToUpdate && bundle.originalStatusUpdate) {
            ordersDB.update((list) => list.map((existing) =>
                existing.id === bundle.originalOrderToUpdate
                    ? { ...existing, status: bundle.originalStatusUpdate as any, updatedAt: order.updatedAt }
                    : existing,
            ));
            recentOrders = recentOrders.map((existing) =>
                existing.id === bundle.originalOrderToUpdate
                    ? { ...existing, status: bundle.originalStatusUpdate as any, updatedAt: order.updatedAt }
                    : existing,
            );
            if (latestTillReceiptOrder?.id === bundle.originalOrderToUpdate) {
                latestTillReceiptOrder = {
                    ...latestTillReceiptOrder,
                    status: bundle.originalStatusUpdate as any,
                    updatedAt: order.updatedAt,
                };
            }
        }
        if (!["hold", "open"].includes(order.status)) {
            const summary = enrichOrderSummary(order as Order);
            recentOrders = [
                summary,
                ...recentOrders.filter((existing) => existing.id !== order.id),
            ].slice(0, RECENT_RECEIPT_LIMIT);
            recentOrderLinesByOrder = new Map(recentOrderLinesByOrder).set(order.id, bundle.lines as OrderLine[]);
            if (order.tillNumber === tillId) latestTillReceiptOrder = summary;
        }
    }

    async function completeSale() {
        if (isCompletingSale) return;
        if (!$currentEmployee || !$currentShiftId || !tillId) {
            toast("This till has no active signed-in shift. Sign in again before taking payment.", "error");
            showPaymentModal = false;
            return;
        }
        if (cart.length === 0) {
            toast("The trolley is empty", "error");
            showPaymentModal = false;
            return;
        }
        if (!Number.isSafeInteger(total) || total < 0 || total > MAX_ORDER_TOTAL_PENCE) {
            toast("The order total is invalid or too large. Check the item quantities and prices.", "error");
            return;
        }
        if (cardCashPartInvalid) {
            toast("For split payment, the cash part must be less than the amount due", "error");
            return;
        }
        const tendered =
            paymentMethod === "cash"
                ? paymentInputAmount
                : paymentDue;
        if (paymentMethod === "cash" && tendered < paymentDue) {
            toast("Amount tendered is less than total", "error");
            return;
        }
        isCompletingSale = true;
        try {
            await ensureTillReceiptSequence();

            // Determine split amounts
            let cashAmount = 0;
            let cardAmount = 0;
            let change = 0;
            let method: 'cash' | 'card' | 'split' | 'loyalty' = paymentMethod;

            if (paymentMethod === "cash") {
                cashAmount = paymentDue;
                cardAmount = 0;
                change = tendered - paymentDue;
            } else if (paymentMethod === "card") {
                // Check if user typed a cash amount less than total (split payment)
                const typedCash = paymentInputAmount;
                if (typedCash > 0 && typedCash < paymentDue) {
                    // Split: part cash, rest on card
                    cashAmount = typedCash;
                    cardAmount = paymentDue - typedCash;
                    change = 0;
                    method = 'split';
                } else {
                    // Full card
                    cashAmount = 0;
                    cardAmount = paymentDue;
                    change = 0;
                }
            }
            if (loyaltyCreditUsed > 0 && paymentDue === 0) {
                method = 'loyalty';
                cashAmount = 0;
                cardAmount = 0;
                change = 0;
            }
            const recordedPaymentMethod = loyaltyCreditUsed > 0 && method !== 'loyalty'
                ? `${method}+loyalty`
                : method;

            const timestamp = now();

            const orderId = uuid();
            const firstPromoId =
            cartEval.lines
                .flatMap((l) => l.applied)
                .map((a) => a.discountId)[0] || "";
            const newOrder = {
            id: orderId,
            shiftId: $currentShiftId,
            customerId: selectedCustomerId,
            employeeId: $currentEmployee?.id || "",
            orderNumber: 0,
            receiptKey: "",
            type: "sale" as const,
            status: "completed" as const,
            originalOrderId: "",
            subtotal,
            discountId: selectedManualDiscountId || firstPromoId,
            discountAmount: promoSavings,
            taxTotal,
            total,
            tillNumber: tillId,
            notes: "",
            paymentMethod: recordedPaymentMethod,
            amountTendered: tendered + loyaltyCreditUsed,
            createdAt: timestamp,
            completedAt: timestamp,
            updatedAt: timestamp,
            };

            const lines = cart.map((item, i) => {
                const ev = cartEval.lines[i];
                const product = productById.get(item.id);
                const lineDiscount = ev?.savings || 0;
                const lineDiscountId = ev?.applied?.[0]?.discountId || "";
                const tax = calculatedTaxLines[i];
                const rate = get(taxRatesDB).find((t) => t.id === product?.taxRateId)?.rate || 0;
                return {
                id: uuid(),
                orderId,
                productId: item.id,
                productName: item.name,
                quantity: item.quantity,
                unitPrice: item.price,
                costPrice: product?.costPrice || 0,
                discountId: lineDiscountId,
                discountAmount: lineDiscount,
                taxRate: rate,
                taxAmount: tax.taxAmount,
                lineTotal: tax.lineTotal,
                isPriceOverride: item.isPriceOverride || (product ? item.price !== product.price : false),
                originalPrice: item.originalPrice ?? product?.price ?? item.price,
                notes: item.note,
                updatedAt: timestamp,
                };
            });

        // Record the payment with split amounts so reports can use them.
            const payment = {
            id: uuid(),
            orderId,
            method,
            amount: total,
            cashAmount,
            cardAmount,
            reference: loyaltyCreditUsed > 0 ? `Loyalty credit ${formatMoney(loyaltyCreditUsed)}` : "",
            changeGiven: paymentMethod === "cash" ? Math.max(0, change) : 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            };
            const stockChanges = stockTrackingEnabled ? cart.flatMap((item) => {
                const product = productById.get(item.id);
                return product?.trackStock && !item.skipStockAdjustment ? [{
                    productId: item.id,
                    delta: -item.quantity,
                    logId: uuid(),
                    employeeId: newOrder.employeeId,
                    notes: "Sale",
                    movementType: "sale",
                }] : [];
            }) : [];
            const audit = {
                id: uuid(),
                employeeId: newOrder.employeeId,
                action: "sale_completed",
                entityType: "order",
                entityId: orderId,
                oldData: "",
                newData: JSON.stringify({ total, customerId: selectedCustomerId, loyaltyCreditUsed, loyaltyPointsEarned }),
                createdAt: timestamp,
            };

            const loyaltyChanges = selectedCustomer && loyaltyConfig.enabled ? [
                ...(loyaltyPointsRedeemed > 0 ? [{
                    id: uuid(), customerId: selectedCustomer.id, orderId,
                    pointsChange: -loyaltyPointsRedeemed, reason: "redeemed", createdAt: timestamp,
                }] : []),
                ...(loyaltyPointsEarned > 0 ? [{
                    id: uuid(), customerId: selectedCustomer.id, orderId,
                    pointsChange: loyaltyPointsEarned, reason: "earned", createdAt: timestamp,
                }] : []),
            ] : [];

            if (trainingModeEnabled) {
                cart = [];
                selectedCartIndex = 0;
                showPaymentModal = false;
                customerDisplayChange = paymentMethod === "cash" ? Math.max(0, change) : 0;
                customerDisplayCompleteUntil = Date.now() + 8000;
                setTimeout(() => {
                    customerDisplayCompleteUntil = 0;
                    customerDisplayChange = 0;
                }, 8000);
                selectedCustomerId = "";
                useLoyaltyCredit = false;
                playSuccessSound();
                toast("Training sale completed. Nothing was saved.", "success");
                return;
            }

            const committedSale = await commitSale({ order: newOrder, lines, payment, stockChanges, loyaltyChanges, audit });
            applyCompletedSaleToStores(committedSale);
            void openDrawerAfterSuccessfulPayment();
            void printReceiptAfterSuccessfulPayment(committedSale);
            sendCctvReceipt({
                storeName: $storeDB.name,
                tillName,
                cashierName: $currentEmployee?.name || "",
                paymentMethod: recordedPaymentMethod,
                subtotal,
                discount: promoSavings,
                total,
                lines: cart.map((item, index) => ({
                    name: item.name,
                    quantity: item.quantity,
                    unitPrice: item.price,
                    lineTotal: lines[index]?.lineTotal ?? Math.max(0, item.price * item.quantity - (cartEval.lines[index]?.savings || 0)),
                    discount: cartEval.lines[index]?.savings || 0,
                })),
            });

            cart = [];
            selectedCartIndex = 0;
            showPaymentModal = false;
            customerDisplayChange = paymentMethod === "cash" ? Math.max(0, change) : 0;
            customerDisplayCompleteUntil = Date.now() + 8000;
            setTimeout(() => {
                customerDisplayCompleteUntil = 0;
                customerDisplayChange = 0;
            }, 8000);
            selectedCustomerId = "";
            useLoyaltyCredit = false;
            playSuccessSound();
            toast(
                paymentMethod === "cash" && change > 0
                    ? `Sale completed. Change: ${formatMoney(change)}`
                    : "Sale completed successfully",
                "success",
                true,
                () => printCompletedSaleReceipt(committedSale),
            );
            void triggerSync();
        } catch (e) {
            console.error(e);
            toast(`Sale was not completed: ${e}`, "error");
        } finally {
            isCompletingSale = false;
        }
    }
</script>

{#if !$currentEmployee && $employeesDB.length > 0}
    <div class="fixed inset-0 z-[1000] bg-bg-base flex items-center justify-center p-3 md:p-5">
        <form class="login-form w-full max-w-[780px] max-h-[96vh] overflow-hidden bg-bg-card border border-border-flat rounded-md p-5 md:p-7 flex flex-col gap-4 shadow-[var(--shadow)]" on:submit|preventDefault={login}>
            <div>
                <h1 class="text-2xl font-bold">Staff Sign In</h1>
                <p class="text-text-muted mt-1">{selectedLoginEmployee ? `Enter the PIN for ${selectedLoginEmployee.name}.` : "Choose your user to open this till."}</p>
            </div>
            {#if !selectedLoginEmployee}
                {#if activeLoginEmployees.length > 0}
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[50vh] overflow-y-auto">
                        {#each activeLoginEmployees as employee}
                            <button
                                type="button"
                                class="flat-card p-4 text-left hover:!border-accent-primary transition-colors"
                                on:click={() => chooseLoginEmployee(employee.id)}
                            >
                                <strong class="block text-text-main">{employee.name}</strong>
                                <span class="text-sm text-text-muted capitalize">{employee.role}</span>
                            </button>
                        {/each}
                    </div>
                {:else}
                    <div class="flat-card p-5 text-center">
                        <strong class="block text-danger">No active staff accounts</strong>
                        <p class="text-sm text-text-muted my-3">All staff accounts are deactivated. Open setup to recover access.</p>
                        <button type="button" class="btn btn-primary" on:click={() => goto('/setup')}>Open Setup</button>
                    </div>
                {/if}
            {:else}
                <div class="login-pin-layout">
                    <section class="login-person">
                        <span>Selected employee</span>
                        <strong>{selectedLoginEmployee.name}</strong>
                        <small class="capitalize">{selectedLoginEmployee.role}</small>
                        <p>Use the touch digit pad to enter your secure PIN.</p>
                        <p class="login-error text-danger font-semibold" aria-live="polite">{loginError || "\u00A0"}</p>
                        <button type="button" class="btn btn-secondary mt-auto" on:click={() => chooseLoginEmployee("")}>Change user</button>
                    </section>
                    <TouchDigitPad
                        bind:value={loginPin}
                        masked={true}
                        maxLength={8}
                        submitLabel="Sign In"
                        submitDisabled={loginPin.length < 4}
                        onSubmit={login}
                    />
                </div>
            {/if}
        </form>
    </div>
{/if}

{#if restoringRememberedSession}
    <div class="fixed inset-0 z-[1050] bg-bg-base/90 flex items-center justify-center p-4">
        <div class="bg-bg-card border border-border-flat rounded-md px-5 py-4 shadow-[var(--shadow)] text-center">
            <strong class="block text-text-main">Reopening staff session</strong>
            <span class="block text-sm text-text-muted mt-1">Checking the till shift...</span>
        </div>
    </div>
{/if}

{#if pendingShiftEmployee}
    <div class="fixed inset-0 z-[1100] bg-bg-base flex items-center justify-center p-3 md:p-5">
        <div class="w-full max-w-[520px] max-h-[96vh] overflow-y-auto bg-bg-card border border-border-flat rounded-md p-5 md:p-7 flex flex-col gap-4 shadow-[var(--shadow)]">
            <div>
                <h1 class="text-2xl font-bold">Open Till Shift</h1>
                <p class="text-text-muted mt-1">Count the opening cash float for {tillName}.</p>
            </div>
            <div class="flat-card p-4 text-center">
                <span class="block text-xs uppercase tracking-wider text-text-muted">Opening float</span>
                <strong class="block text-3xl mt-1">{formatMoney(parseInt(openingFloatString) || 0)}</strong>
            </div>
            <TouchDigitPad
                bind:value={openingFloatString}
                maxLength={9}
                placeholder="Enter opening float in pence"
                submitLabel="Open Shift"
                onSubmit={openShiftWithFloat}
            />
            <button type="button" class="btn btn-secondary" on:click={cancelOpeningShift}>Cancel and Sign Out</button>
        </div>
    </div>
{/if}

<div
    class="pos-checkout-shell flex h-screen w-screen overflow-hidden"
    on:click={handlePosBackgroundClick}
>
    <!-- Main Content (Products) -->
    <main class="pos-products flex-1 flex flex-col p-2 md:p-3 lg:p-5 overflow-hidden">
        <header
            class="pos-main-header grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-3 h-12 md:h-14 lg:h-16 mb-2 md:mb-3 lg:mb-5 shrink-0"
        >
            <div class="flex min-w-0 items-center gap-4">
                <div>
                    <button
                        class="h-12 min-w-[104px] rounded-md bg-bg-card border border-border-flat px-3 flex items-center justify-center gap-2 font-black text-text-main hover:bg-bg-card-hover hover:border-accent-primary transition-colors {isMenuDisabled ? 'opacity-70' : ''}"
                        aria-disabled={isMenuDisabled}
                        title="Open Admin"
                        on:click|stopPropagation={() => handleMenuClick("/admin")}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            width="20"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            ><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect
                                x="14"
                                y="3"
                                width="7"
                                height="7"
                                rx="1"
                            ></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect
                                x="14"
                                y="14"
                                width="7"
                                height="7"
                                rx="1"
                            ></rect></svg
                        >
                        <span>Admin</span>
                    </button>
                </div>

                <button
                    class="flex items-center gap-3 bg-transparent hover:bg-bg-card rounded-md p-1.5 transition-colors"
                    title="Change user"
                    on:click={logoutEmployee}
                >
                    <div
                        class="w-10 h-10 bg-accent-primary rounded-full flex items-center justify-center font-serif font-bold text-base text-white"
                    >
                        {$storeDB.name.substring(0, 2).toUpperCase()}
                    </div>
                    <span class="max-w-[120px] truncate font-semibold text-text-muted xl:max-w-[180px]">{$currentEmployee?.name || 'Signed out'}</span>
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        width="16"
                        ><polyline points="6 9 12 15 18 9"></polyline></svg
                    >
                </button>
            </div>

            <h1
                class="min-w-0 max-w-[34vw] truncate text-center text-xl md:text-2xl lg:text-3xl font-black text-text-main tracking-tight"
                title={$storeDB.name}
            >
                {$storeDB.name}
            </h1>
            <div
                class="sync-pill justify-self-end {syncStyle}"
                title={$connectionState.syncError || syncLabel}
            >
                <span></span>
                {syncLabel}
            </div>
        </header>

        {#if trainingModeEnabled}
            <div class="mb-3 rounded-xl border border-warning/50 bg-warning/15 px-4 py-2 text-center text-sm font-black uppercase tracking-[0.18em] text-warning">
                Training Mode: sales are not saved
            </div>
        {/if}

        <!-- POS Pages -->
        <div class="pos-page-tabs flex gap-3 overflow-x-auto pb-3 mb-5">
            {#each $activePosPages as page}
                <button
                    class="whitespace-nowrap px-6 py-3 rounded-sm font-semibold text-sm transition-colors {activePageId ===
                    page.id
                        ? 'bg-accent-primary text-white border-accent-primary'
                        : 'bg-bg-card border border-border-flat text-text-muted hover:text-text-main hover:bg-bg-card-hover'}"
                    on:click={() => {
                        activePageId = page.id;
                        currentPageIndex = 0;
                    }}
                >
                    {page.name}
                </button>
            {/each}
        </div>

        <!-- Product Grid (Fixed 4x3) -->
        <div class="pos-product-workspace flex flex-col gap-2 md:gap-3 lg:gap-5 flex-1 min-h-0">
            <div class="pos-product-grid grid grid-cols-4 grid-rows-4 gap-1 md:gap-2 lg:gap-3 flex-1 min-h-0">
                {#each displayTiles as slot, tileIndex (`${currentPageIndex}:${tileIndex}:${slot?.tile.id || "empty"}:${slot?.product?.updatedAt || ""}:${slot?.product?.price ?? ""}`)}
                    {#if slot && slot.product}
                        {@const temporaryOffer = activeTemporaryOffer(slot.product.id, slot.product.price, promoClock)}
                        <div
                            class="relative h-full min-h-0 overflow-hidden cursor-pointer bg-[var(--tile-bg)] border border-border-flat rounded-md transition-colors hover:brightness-110 flex flex-col"
                            on:click={() => slot.product!.isWeighable ? openScaleForProduct(slot.product!.id) : addToCart(slot.product!)}
                        >
                            <div
                                class="relative flex-1 min-h-0 overflow-hidden"
                                style="background-color: {slot.product.color ||
                                    '#3b82f6'}"
                            >
                                {#if slot.product.image}
                                    <img
                                        src={slot.product.image}
                                        alt={slot.product.name}
                                        class="absolute inset-0 h-full w-full object-cover"
                                    />
                                {/if}
                                <div
                                    class="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent"
                                >
                                    <div class="flex items-end justify-between gap-2">
                                        <h3
                                            class="m-0 text-[11px] md:text-sm lg:text-base font-semibold text-white line-clamp-2 leading-tight"
                                        >
                                            {slot.product.name}
                                        </h3>
                                        <span
                                            class="bg-[var(--price-bg)] px-2 py-1 rounded-sm text-[var(--price-text)] font-bold text-[10px] md:text-xs lg:text-sm shrink-0"
                                        >
                                            {#if temporaryOffer}
                                                <small class="block line-through opacity-70">{formatMoney(slot.product.price)}</small>
                                                {formatMoney(temporaryOffer.price)}
                                            {:else}
                                                {formatMoney(slot.product.price)}
                                            {/if}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    {:else}
                        <div
                            class="bg-bg-card/30 border border-border-flat/30 border-dashed rounded-md"
                        ></div>
                    {/if}
                {/each}
            </div>
            <div class="pos-toolbar flex items-center gap-1.5 md:gap-2 h-14 md:h-16 shrink-0">
                <button
                    class="h-full min-w-11 md:min-w-14 px-3 flex items-center justify-center gap-2 bg-bg-card border border-border-flat text-accent-primary rounded-md hover:bg-accent-primary hover:text-white transition-colors shrink-0 disabled:opacity-45 disabled:cursor-wait"
                    title="Open cash drawer"
                    disabled={drawerBusy}
                    on:click={handleOpenCashDrawer}
                >
                    {#if drawerBusy}
                        <span class="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"></span>
                    {:else}
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            width="18"
                        >
                            <rect x="3" y="7" width="18" height="12" rx="2"></rect>
                            <path d="M7 7V5h10v2"></path>
                            <path d="M3 12h18"></path>
                            <path d="M10 16h4"></path>
                        </svg>
                    {/if}
                    <span class="hidden xl:inline text-xs font-black uppercase tracking-wide">Drawer</span>
                </button>
                {#if totalPages > 1}
                    <button
                        class="w-11 h-full md:w-14 flex items-center justify-center bg-bg-card border border-border-flat rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-bg-card-hover transition-colors text-sm font-bold"
                        disabled={currentPageIndex === 0}
                        on:click={() => currentPageIndex--}>&larr;</button
                    >
                    <span class="text-xs md:text-sm font-semibold text-text-muted w-11 h-full md:w-14 flex items-center justify-center leading-none"
                        >{currentPageIndex + 1}<span class="text-text-muted/50">/</span>{totalPages}</span
                    >
                    <button
                        class="w-11 h-full md:w-14 flex items-center justify-center bg-bg-card border border-border-flat rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-bg-card-hover transition-colors text-sm font-bold"
                        disabled={currentPageIndex >= totalPages - 1}
                        on:click={() => currentPageIndex++}>&rarr;</button
                    >
                {:else}
                    <div class="w-11 h-full md:w-14"></div>
                    <div class="w-11 h-full md:w-14"></div>
                    <div class="w-11 h-full md:w-14"></div>
                {/if}
                <div class="pos-toolbar-actions" style="--pos-toolbar-count: {toolbarLayout.length}">
                    {#each toolbarLayout as btn}
                        {#if btn === 'scale'}
                            <button class="pos-toolbar-action" on:click={openScale}>SCALE</button>
                        {:else if btn === 'label_print'}
                            <button class="pos-toolbar-action" on:click={() => goto('/label-print')}>LABEL PRINT</button>
                        {:else if btn === 'discount'}
                            <button class="pos-toolbar-action" on:click={openDiscounts}>DISCOUNT</button>
                        {:else if btn === 'goods'}
                            <button class="pos-toolbar-action" on:click={openGoodsModal}>GOODS</button>
                        {:else if btn === 'recent_trans'}
                            <button class="pos-toolbar-action" on:click={openRecentTransactions}>RECENT<br class="hidden md:inline"/>TRANS</button>
                        {:else if btn === 'change_price'}
                            <button
                                class="pos-toolbar-action disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-card"
                                disabled={!hasSelectedCartItem}
                                on:click={openChangePrice}>CHANGE<br class="hidden md:inline"/>PRICE</button>
                        {/if}
                    {/each}
                </div>
            </div>
        </div>
    </main>

    <!-- Cart / Trolly -->
    <aside
        class="pos-cart flex flex-col w-[34vw] min-w-[330px] max-w-[480px] bg-bg-panel border-l border-border-flat shrink-0 overflow-hidden"
    >
        <!-- Compact Trolly Header (Order info + Search + Clear) -->
        <div
            class="pos-cart-header flex items-center gap-2 md:gap-3 p-3 md:p-4 border-b border-border-flat bg-bg-panel shrink-0"
        >
            <div class="flex flex-col gap-0.5 min-w-[80px]">
                <span
                    class="text-[10px] md:text-xs font-bold text-text-muted uppercase tracking-wider leading-none"
                    >Till</span
                >
                <div class="flex items-center gap-2">
                    <span
                        class="text-sm md:text-base lg:text-lg font-bold text-accent-primary leading-none"
                        >{tillName || tillId}</span
                    >
                    {#if heldOrdersForTill.length > 0}
                        <button
                            class="bg-warning/20 text-warning text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-warning/30 animate-pulse"
                            on:click|stopPropagation={() =>
                                (showHeldOrders = true)}
                            >{heldOrdersForTill.length} held</button
                        >
                    {/if}
                </div>
            </div>

            <div
                class="flex-1 flex items-center gap-2 bg-bg-card border border-border-flat rounded-md px-3 h-10 focus-within:border-accent-primary transition-colors {showNotFoundModal ? 'opacity-40 pointer-events-none' : ''}"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    width="16"
                    class="text-text-muted"
                    ><circle cx="11" cy="11" r="8"></circle><line
                        x1="21"
                        y1="21"
                        x2="16.65"
                        y2="16.65"
                    ></line></svg
                >
                <input
                    bind:this={scanInput}
                    type="text"
                    placeholder="Search/Scan..."
                    class="bg-transparent border-none outline-none text-sm text-text-main w-full disabled:opacity-40"
                    bind:value={searchQuery}
                    on:keydown={handleSearchKeydown}
                    disabled={showNotFoundModal}
                    data-touch-keyboard="off"
                />
            </div>

            <button
                class="w-10 h-10 flex items-center justify-center bg-bg-card border border-border-flat text-danger rounded-md hover:bg-danger hover:text-white transition-colors shrink-0"
                title="Clear Order"
                on:click={() => (showClearConfirm = true)}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    width="18"
                    ><polyline points="3 6 5 6 21 6"></polyline><path
                        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                    ></path></svg
                >
            </button>
        </div>

        <!-- Cart Items List -->
        <div class="pos-cart-items flex-1 overflow-y-auto p-2 md:p-3 flex flex-col gap-1.5 relative">
            {#if trolleyMessage}
                <div
                    class="absolute top-2 left-3 right-3 z-10 p-3 rounded-md text-sm font-semibold shadow-lg text-center transition-all {trolleyMessageType ===
                    'error'
                        ? 'bg-danger text-white'
                        : trolleyMessageType === 'success'
                          ? 'bg-success text-white'
                          : 'bg-accent-primary text-white'}"
                >
                    {trolleyMessage}
                </div>
            {/if}
            {#each cart as item, i}
                {@const scaleDisplay = getScaleSaleDisplay(item.note, item.quantity, item.price, item.originalPrice)}
                {@const promoNotice = getCartPromotionNotice(cartEval.lines[i])}
                {@const lineSavings = cartEval.lines[i]?.savings || 0}
                {@const lineGross = item.price * item.quantity}
                {@const lineNet = Math.max(0, lineGross - lineSavings)}
                <div
                    bind:this={cartItemEls[i]}
                    class="cart-line flex items-center gap-1.5 p-1 md:p-1.5 rounded-md border transition-all cursor-pointer group {selectedCartIndex === i ? 'cart-line-selected' : 'cart-line-normal'} {promoNotice?.kind === 'applied' ? 'cart-line-promo-applied' : promoNotice?.kind === 'eligible' ? 'cart-line-promo-eligible' : ''}"
                    on:click={() => (selectedCartIndex = i)}
                >
                    <div
                        class="text-[11px] md:text-xs font-bold text-accent-primary min-w-[18px] md:min-w-[22px] pt-0.5"
                    >
                        {scaleDisplay.label}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="cart-line-title">
                            <h4
                                class="m-0 text-[12px] md:text-[13px] font-black text-text-main truncate leading-tight"
                                title={item.name}
                            >
                                {item.name}
                            </h4>
                            {#if promoNotice}
                                <span class="cart-promo-chip cart-promo-chip-{promoNotice.kind}" title={promoNotice.title}>{promoNotice.label}</span>
                            {/if}
                        </div>
                        {#if item.quantityLocked}
                            <span class="text-[9px] md:text-[10px] font-bold uppercase tracking-wide text-warning">Scale label · fixed quantity</span>
                        {/if}
                        {#if item.note}
                            <span
                                class="text-[9px] text-text-muted italic block truncate mt-0.5 leading-tight"
                                >{item.note}</span
                            >
                        {/if}
                    </div>
                    <div class="cart-line-price w-[62px] md:w-[74px] text-right shrink-0">
                        {#if lineSavings > 0}
                            <div class="cart-price-original">
                                {formatMoney(lineGross)}
                            </div>
                            <div class="cart-price-discounted">
                                {formatMoney(lineNet)}
                            </div>
                        {:else}
                            <div class="text-[9px] md:text-[10px] text-text-muted font-semibold leading-tight truncate">
                                {formatMoney(item.price)}
                            </div>
                            <div class="text-[12px] md:text-[13px] font-black text-text-main leading-tight mt-0.5 truncate">
                                {formatMoney(lineGross)}
                            </div>
                        {/if}
                    </div>
                    <button
                        class="w-6 h-6 flex items-center justify-center text-text-muted hover:text-danger opacity-60 group-hover:opacity-100 transition-all shrink-0"
                        on:click|stopPropagation={() => deleteItem(i)}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            width="16"
                            ><line x1="18" y1="6" x2="6" y2="18"></line><line
                                x1="6"
                                y1="6"
                                x2="18"
                                y2="18"
                            ></line></svg
                        >
                    </button>
                </div>
            {/each}
        </div>

        <!-- Selection Controls & Quantity -->
        <div class="pos-cart-controls flex gap-1 md:gap-2 p-2 md:p-4 pb-0 shrink-0">
            <button
                disabled={!hasSelectedCartItem || selectedCartItem?.quantityLocked}
                title={selectedCartItem?.quantityLocked ? "Scale-label quantity cannot be changed" : "Increase quantity"}
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md text-base md:text-lg lg:text-xl font-bold hover:bg-bg-card-hover transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                on:click={increaseQty}>+</button
            >
            <button
                disabled={!hasSelectedCartItem || selectedCartItem?.quantityLocked}
                title={selectedCartItem?.quantityLocked ? "Scale-label quantity cannot be changed" : "Decrease quantity"}
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md text-base md:text-lg lg:text-xl font-bold hover:bg-bg-card-hover transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                on:click={decreaseQty}>-</button
            >
            <button
                disabled={selectedCartIndex <= 0}
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md hover:bg-bg-card-hover transition-colors text-text-main disabled:opacity-35 disabled:cursor-not-allowed"
                on:click={moveSelectionUp}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="w-4 h-4 md:w-5 md:h-5"
                    ><polyline points="18 15 12 9 6 15"></polyline></svg
                >
            </button>
            <button
                disabled={!hasSelectedCartItem || selectedCartIndex >= cart.length - 1}
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md hover:bg-bg-card-hover transition-colors text-text-main disabled:opacity-35 disabled:cursor-not-allowed"
                on:click={moveSelectionDown}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="w-4 h-4 md:w-5 md:h-5"
                    ><polyline points="6 9 12 15 18 9"></polyline></svg
                >
            </button>
            <button
                disabled={!hasSelectedCartItem}
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md text-danger hover:bg-danger hover:text-white transition-colors disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-bg-card disabled:hover:text-danger"
                on:click={deleteSelected}
                title="Delete selected"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="w-4 h-4 md:w-[18px] md:h-[18px]"
                    ><polyline points="3 6 5 6 21 6"></polyline><path
                        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                    ></path></svg
                >
            </button>
            <button
                disabled={!hasSelectedCartItem || selectedCartItem?.quantityLocked}
                title={selectedCartItem?.quantityLocked ? "Scale-label quantity cannot be changed" : "Set quantity"}
                class="flex-[2] h-8 md:h-10 lg:h-12 flex items-center justify-center gap-1 md:gap-2 bg-bg-card border border-border-flat rounded-md font-bold text-[10px] md:text-sm hover:bg-bg-card-hover transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                on:click={openQuantityPad}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="w-3.5 h-3.5 md:w-[18px] md:h-[18px]"
                    ><rect x="3" y="3" width="18" height="18" rx="2" ry="2"
                    ></rect><line x1="3" y1="9" x2="21" y2="9"></line><line
                        x1="9"
                        y1="21"
                        x2="9"
                        y2="9"
                    ></line></svg
                >
                <span>Qty</span>
            </button>
        </div>

        <!-- Total Section -->
        <div class="pos-total-section px-2 md:px-4 py-1 md:py-2 shrink-0">
            <div
                class="pos-total-row flex justify-between items-center py-3 border-y border-border-flat my-1"
            >
                <div class="flex flex-col gap-0.5 min-w-0">
                    <span
                        class="text-lg md:text-xl font-bold text-text-muted uppercase tracking-wider"
                        >Total</span
                    >
                    {#if promoSavings > 0}
                        <span
                            class="pos-promo-summary {selectedPromotionNotice ? `pos-promo-summary-${selectedPromotionNotice.kind}` : 'pos-promo-summary-applied'}"
                            title={selectedPromotionNotice?.title || `Promotions saved ${formatMoney(promoSavings)}`}
                        >
                            {selectedPromotionNotice?.detail || `Promotions -${formatMoney(promoSavings)}`}
                        </span>
                    {:else if selectedPromotionNotice}
                        <span
                            class="pos-promo-summary pos-promo-summary-{selectedPromotionNotice.kind}"
                            title={selectedPromotionNotice.title}
                        >
                            {selectedPromotionNotice.detail}
                        </span>
                    {/if}
                </div>
                <div class="flex flex-col items-end">
                    <span
                        class="text-2xl md:text-3xl lg:text-4xl font-black text-accent-primary tracking-tight"
                        >{formatMoney(total)}</span
                    >
                    <span class="mt-1 text-xs md:text-sm text-text-muted"
                        >Total Items: {totalItems}</span
                    >
                </div>
            </div>
        </div>

        <!-- Cart Action Buttons Grid -->
        <div class="pos-action-grid grid grid-cols-3 gap-1 md:gap-2 px-2 md:px-4 pb-2 md:pb-4 shrink-0 auto-rows-[2.5rem] md:auto-rows-[3.5rem]">
            {#each [...cartLayout.slice(0, 2), 'payment', ...cartLayout.slice(2)] as btn}
                {#if btn === 'payment'}
                    <button
                        class="payment-action row-span-2 h-full bg-success text-white text-base md:text-lg font-black rounded-md shadow-lg hover:brightness-110 active:scale-[0.98] transition-all tracking-wider flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100"
                        disabled={cart.length === 0}
                        on:click={openPayment}>PAYMENT</button
                    >
                {:else if btn === 'goods'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        on:click={openGoodsModal}>GOODS</button
                    >
                {:else if btn === 'last_receipt'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[10px] font-bold leading-tight hover:bg-bg-card-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={lastReceiptPrinting || !latestTillReceiptOrder}
                        on:click={printLastTillReceipt}>{lastReceiptPrinting ? 'PRINTING' : 'LAST'}<br/>{lastReceiptPrinting ? '...' : 'RECEIPT'}</button
                    >
                {:else if btn === 'change_price'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md font-bold text-xs hover:bg-bg-card-hover transition-colors leading-tight disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-card"
                        disabled={!hasSelectedCartItem}
                        on:click={openChangePrice}>CHANGE<br/>PRICE</button
                    >
                {:else if btn === 'hold'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[10px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={cart.length === 0 || isHoldingOrder}
                        on:click={holdOrder}>{isHoldingOrder ? 'HOLDING...' : 'HOLD'}</button
                    >
                {:else if btn === 'scale'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        on:click={openScale}>SCALE</button
                    >
                {:else if btn === 'discount'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        on:click={openDiscounts}>DISCOUNT</button
                    >
                {/if}
            {/each}
        </div>
    </aside>
</div>

{#if showDiscountModal}
    <div class="modal-overlay" on:click={() => (showDiscountModal = false)}>
        <div class="flat-panel modal-box" on:click|stopPropagation>
            <div class="modal-header">
                <div>
                    <h3>Apply Discount</h3>
                    <p class="m-0 text-sm text-text-muted">Choose one manual percentage discount for this sale.</p>
                </div>
                <button class="modal-close" on:click={() => (showDiscountModal = false)}>✕</button>
            </div>
            <div class="modal-body grid grid-cols-2 gap-3">
                <button
                    class="flat-card p-4 text-left cursor-pointer hover:!border-accent-primary {selectedManualDiscountId === '' ? '!border-accent-primary' : ''}"
                    on:click={() => selectManualDiscount('')}
                >
                    <strong class="block text-text-main">No manual discount</strong>
                    <span class="text-sm text-text-muted">Remove the selected percentage discount</span>
                </button>
                {#each $discountsDB.filter(d => d.kind === 'manual_percent' && d.isActive) as discount}
                    <button
                        class="flat-card p-4 text-left cursor-pointer hover:!border-accent-primary {selectedManualDiscountId === discount.id ? '!border-accent-primary' : ''}"
                        on:click={() => selectManualDiscount(discount.id)}
                    >
                        <strong class="block text-text-main">{discount.name}</strong>
                        <span class="text-lg font-bold text-success">{discount.value}% off</span>
                    </button>
                {/each}
                {#if $discountsDB.filter(d => d.kind === 'manual_percent' && d.isActive).length === 0}
                    <p class="col-span-2 text-center text-text-muted p-5">No active percentage discounts. Add one from Discounts & Promotions.</p>
                {/if}
            </div>
        </div>
    </div>
{/if}

{#if showScaleModal}
    <div class="modal-overlay" on:click={closeScaleModal}>
        <div class="scale-workspace" on:click|stopPropagation>
            <header class="scale-header">
                <div>
                    <span class="scale-kicker">Manual weighing</span>
                    <h2>Scale</h2>
                    <p>Select a product, enter its weight, then add the calculated total.</p>
                </div>
                <button class="modal-close scale-close" on:click={closeScaleModal}>✕</button>
            </header>

            <div class="scale-layout">
                <section class="scale-products">
                    <div class="scale-page-tabs">
                        {#each scaleTilePages as page}
                            <button
                                class={page.id === activeScaleTilePageId ? '!border-[var(--scale-page-color)] !bg-bg-card' : ''}
                                style="--scale-page-color: {page.color}"
                                on:click={() => { activeScaleTilePageId = page.id; scalePage = 0; scaleSearch = ""; }}
                            >
                                <i></i>{page.name}
                            </button>
                        {/each}
                    </div>
                    <input class="search-input" value={scaleSearch} on:input={(event) => { scaleSearch = event.currentTarget.value; scalePage = 0; }} placeholder="Search weighable products, SKU, barcode, or PLU..." />
                    {#if visibleScaleProducts.length}
                        <div class="scale-product-grid">
                            {#each pagedScaleProducts as product}
                                {#if product}
                                    <button
                                        class="scale-product {product.image ? 'with-image' : ''} {selectedScaleProductId === product.id ? 'selected' : ''}"
                                        style="--scale-color: {product.color || '#3b82f6'}"
                                        on:click={() => (selectedScaleProductId = product.id)}
                                    >
                                        <i></i>
                                        {#if product.image}
                                            <img class="scale-product-photo" src={product.image} alt={product.name} />
                                            <span class="scale-product-shade"></span>
                                        {/if}
                                        <div class="scale-product-content">
                                            <strong>{product.name}</strong>
                                            <span>{formatMoney(product.price)} / kg</span>
                                            {#if product.scalePlu}<small>PLU {product.scalePlu}</small>{/if}
                                        </div>
                                    </button>
                                {/if}
                            {/each}
                        </div>
                        <div class="scale-pagination">
                            <span>Showing {scalePage * SCALE_PRODUCTS_PER_PAGE + 1}–{Math.min((scalePage + 1) * SCALE_PRODUCTS_PER_PAGE, visibleScaleProducts.length)} of {visibleScaleProducts.length}</span>
                            <div>
                                <button disabled={scalePage === 0} on:click={() => scalePage--}>&larr; Previous</button>
                                <strong>{scalePage + 1} / {scalePageCount}</strong>
                                <button disabled={scalePage >= scalePageCount - 1} on:click={() => scalePage++}>Next &rarr;</button>
                            </div>
                        </div>
                    {:else}
                        <div class="scale-empty">
                            No products are assigned to this Scale page. Add weighable products in Design Studio.
                        </div>
                    {/if}
                </section>

                <aside class="scale-entry">
                    <div class="scale-selected">
                        <span>Selected product</span>
                        <strong>{selectedScaleProduct?.name || "Choose a tile"}</strong>
                        <small>{selectedScaleProduct ? `${formatMoney(selectedScaleProduct.price)} per kilogram` : "The price stored on a weighable item is its price per kg."}</small>
                    </div>
                    <div class="scale-units">
                        <button class={scaleWeightUnit === "kg" ? '!border-success !bg-success !text-white' : ''} on:click={() => (scaleWeightUnit = "kg")}>Kilograms</button>
                        <button class={scaleWeightUnit === "g" ? '!border-success !bg-success !text-white' : ''} on:click={() => (scaleWeightUnit = "g")}>Grams</button>
                    </div>
                    <div class="scale-display">
                        <span>Weight</span>
                        <strong>{scaleWeightInput || "0"} <small>{scaleWeightUnit}</small></strong>
                    </div>
                    <div class="scale-live">
                        <div>
                            <span>{scaleHardwareReady ? `Scale port ${scaleHardwareConfig.devicePath}` : "Scale not connected"}</span>
                            <small>{scaleReadStatus || (scaleHardwareReady ? "Waiting for live weight..." : "Use Printer Setup to choose the scale port.")}</small>
                        </div>
                        <button class="btn btn-secondary" disabled={!scaleHardwareReady || scaleReadBusy} on:click={() => readScaleNow(true)}>
                            {scaleReadBusy ? "Reading..." : "Read Scale"}
                        </button>
                    </div>
                    <div class="scale-numpad">
                        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"] as key}
                            <button on:click={() => handleScaleKey(key)}>{key}</button>
                        {/each}
                    </div>
                    <div class="scale-total">
                        <span>Total price</span>
                        <strong>{formatMoney(scaleLinePrice)}</strong>
                    </div>
                    <button class="btn btn-success scale-add" disabled={!selectedScaleProduct || scaleWeightKg <= 0} on:click={addManualScaleItem}>
                        Add Weighed Item
                    </button>
                </aside>
            </div>
        </div>
    </div>
{/if}

<!-- Numpad Modal (for Qty) -->
{#if showNumpad}
    <div
        class="fixed inset-0 bg-[var(--overlay)] z-[100] flex items-center justify-center p-5"
        on:click={() => (showNumpad = false)}
    >
        <div
            class="w-80 max-w-[95vw] max-h-[85vh] md:max-h-[90vh] overflow-y-auto p-6 rounded-md bg-bg-card flex flex-col gap-4 shadow-[var(--shadow)]"
            on:click|stopPropagation
        >
            <div class="flex justify-between items-center">
                <h3 class="m-0 text-lg font-semibold">Enter Quantity</h3>
                <button
                    class="text-text-muted text-xl hover:text-text-main transition-colors"
                    on:click={() => (showNumpad = false)}>✕</button
                >
            </div>
            <div
                class="h-12 md:h-16 flex items-center justify-end px-4 text-2xl md:text-3xl font-bold bg-bg-panel border border-border-flat rounded-md font-serif"
            >
                {numpadValue || "0"}
            </div>
            <div class="grid grid-cols-3 gap-3">
                {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "ENTER"] as key}
                    <button
                        class="h-10 md:h-12 lg:h-14 flex items-center justify-center text-base md:text-xl font-bold rounded-md transition-colors border border-border-flat {key ===
                        'ENTER'
                            ? 'col-span-2 bg-success text-white hover:brightness-110'
                            : key === 'C'
                              ? 'text-danger bg-bg-panel hover:bg-danger hover:text-white'
                              : 'bg-bg-panel text-text-main hover:bg-bg-card-hover'}"
                        on:click={() => handleNumpadKey(key)}
                    >
                        {key}
                    </button>
                {/each}
            </div>
        </div>
    </div>
{/if}

<!-- Change Price Modal -->
{#if showChangePricePad}
    <div
        class="fixed inset-0 bg-[var(--overlay)] z-[100] flex items-center justify-center p-5"
        on:click={() => (showChangePricePad = false)}
    >
        <div
            class="w-96 max-w-[95vw] max-h-[85vh] md:max-h-[90vh] overflow-y-auto p-6 rounded-md bg-bg-card flex flex-col gap-4 shadow-[var(--shadow)]"
            on:click|stopPropagation
        >
            <div class="flex justify-between items-center">
                <h3 class="m-0 text-lg font-semibold">Change Price</h3>
                <button
                    class="text-text-muted text-xl hover:text-text-main transition-colors"
                    on:click={() => (showChangePricePad = false)}>✕</button
                >
            </div>
            <div
                class="h-16 flex items-center justify-end px-4 text-3xl font-bold bg-bg-panel border border-border-flat rounded-md font-serif text-accent-primary"
            >
                {formatMoney(parseInt(changePriceString || "0"))}
            </div>
            <div class="grid grid-cols-3 gap-3">
                {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "C"] as key}
                    <button
                        class="h-14 flex items-center justify-center text-xl font-bold rounded-md transition-colors border border-border-flat {key ===
                        'C'
                            ? 'text-danger bg-bg-panel hover:bg-danger hover:text-white'
                            : 'bg-bg-panel text-text-main hover:bg-bg-card-hover'}"
                        on:click={() => handleChangePriceKey(key)}
                    >
                        {key}
                    </button>
                {/each}
            </div>
            <div class="flex flex-col gap-2 mt-2">
                <button
                    class="w-full h-14 bg-accent-primary text-white font-bold rounded-md hover:bg-accent-primary-hover transition-colors"
                    on:click={changePriceOnce}
                    >Change only for this order</button
                >
                <button
                    class="w-full h-14 border border-danger text-danger font-bold rounded-md hover:bg-danger hover:text-white transition-colors"
                    on:click={changePricePermanently}>Change permanently</button
                >
            </div>
        </div>
    </div>
{/if}

<!-- Goods / Open Price Modal -->
{#if showGoodsModal}
    <div class="modal-overlay" on:click={() => (showGoodsModal = false)}>
        <div
            class="w-[700px] max-w-[95vw] max-h-[85vh] md:max-h-[90vh] flex flex-col md:flex-row p-0 overflow-y-auto md:overflow-hidden bg-bg-card border border-border-flat rounded-md"
            on:click|stopPropagation
        >
            <!-- Left Side: Open Departments -->
            <div
                class="flex-1 border-r border-border-flat flex flex-col bg-bg-base"
            >
                <div class="p-5 border-b border-border-flat bg-bg-panel">
                    <h3 class="m-0 text-[1.2rem]">Select Department</h3>
                    <div class="mt-2">
                        <input
                            type="text"
                            class="w-full px-3 py-2 bg-bg-panel border border-border-flat rounded-sm text-text-main text-[0.85rem] outline-none focus:border-accent-primary"
                            bind:value={goodsSearchQuery}
                            placeholder="Filter..."
                        />
                    </div>
                </div>
                <div
                    class="p-5 flex flex-col gap-3 overflow-y-auto max-h-[60vh]"
                >
                    {#each filteredGoods.slice(0, 50) as item}
                        <button
                            class="flat-card p-4 text-[1.1rem] font-semibold cursor-pointer text-left hover:border-accent-primary"
                            style="border-left: 4px solid {item.color ||
                                '#6366f1'}"
                            on:click={() => addGoodsItem(item)}
                        >
                            {item.name}
                        </button>
                    {/each}
                    {#if filteredGoods.length > 50}
                        <div
                            class="p-3 text-center text-[0.8rem] text-accent-primary bg-bg-panel rounded-sm m-2 font-semibold"
                        >
                            Showing first 50 results. Use filter to find more.
                        </div>
                    {/if}
                    {#if filteredGoods.length === 0}
                        <p
                            class="text-center text-text-muted p-5 text-[0.9rem]"
                        >
                            No items match your filter.
                        </p>
                    {/if}
                </div>
            </div>

            <!-- Right Side: Numpad -->
            <div class="w-[340px] p-6 flex flex-col bg-bg-card">
                <div class="modal-header">
                    <h3>Enter Price</h3>
                    <button
                        class="modal-close"
                        on:click={() => (showGoodsModal = false)}>✕</button
                    >
                </div>
                <div class="np-display mb-4 mt-2">
                    {formatMoney(parseInt(goodsPriceString || "0"))}
                </div>
                <div class="np-grid">
                    {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "C"] as key}
                        <button
                            class="np-btn {key === 'C' ? 'np-clear' : ''}"
                            on:click={() => handleGoodsPadKey(key)}
                        >
                            {key}
                        </button>
                    {/each}
                </div>
            </div>
        </div>
    </div>
{/if}

<!-- Payment Modal -->
{#if showPaymentModal}
    <div class="modal-overlay" on:click={closePayment}>
        <div
            class="payment-modal w-[1040px] max-w-[96vw] max-h-[94vh] overflow-hidden p-3 md:p-4 rounded-md bg-bg-card border border-border-flat flex flex-col gap-3"
            on:click|stopPropagation
        >
            <div
                class="payment-modal-header flex justify-between items-center border-b border-border-flat pb-3"
            >
                <h2 class="m-0 text-text-main text-xl md:text-[1.5rem]">Payment</h2>
                <button
                    class="modal-close"
                    disabled={isCompletingSale}
                    on:click={closePayment}>✕</button
                >
            </div>

            {#if loyaltyConfig.enabled}
                <section class="payment-loyalty grid grid-cols-1 md:grid-cols-[1fr_1.1fr] gap-2 p-2.5 rounded-md border border-border-flat bg-bg-panel">
                    <div class="relative">
                        <label class="block text-xs font-bold text-text-muted mb-1">Scan loyalty barcode or search customer</label>
                        <input
                            bind:this={customerSearchInput}
                            class="flat-input payment-customer-input w-full"
                            bind:value={customerSearch}
                            on:keydown={handleCustomerSearchKeydown}
                            data-touch-keyboard="manual"
                            placeholder="Name, loyalty code, phone, or postcode"
                        />
                        {#if customerMatches.length > 0}
                            <div class="absolute z-20 left-0 right-0 mt-1 p-1 bg-bg-card border border-border-flat rounded-md shadow-lg">
                                {#each customerMatches as customer}
                                    <button class="w-full p-2 text-left rounded-sm hover:bg-bg-card-hover" on:click={() => selectPaymentCustomer(customer)}>
                                        <strong>{customer.name}</strong>
                                        <small class="block text-text-muted">{customer.loyaltyCode || 'No loyalty code'} · {customer.postcode || 'No postcode'}</small>
                                    </button>
                                {/each}
                            </div>
                        {/if}
                    </div>
                    {#if selectedCustomer}
                        <div class="flex items-center justify-between gap-3 p-2 rounded-md bg-bg-card border border-accent-primary/40">
                            <div>
                                <strong class="block">{selectedCustomer.name}</strong>
                                <span class="text-xs text-text-muted">{selectedCustomer.loyaltyCode}</span>
                                <div class="mt-1 text-sm"><b>{selectedCustomer.loyaltyPoints} points</b> · {formatMoney(availableLoyaltyCredit)} available</div>
                                <small class="text-success">This sale earns {loyaltyPointsEarned} points</small>
                            </div>
                            <div class="flex flex-col gap-2">
                                <button class="btn btn-secondary {useLoyaltyCredit ? '!bg-success !text-white' : ''}" disabled={availableLoyaltyCredit <= 0 || !loyaltyRedemptionAvailable} on:click={toggleLoyaltyCredit}>
                                    {useLoyaltyCredit ? `Using ${formatMoney(loyaltyCreditUsed)}` : loyaltyRedemptionAvailable ? 'Use Credit' : 'Credit Offline'}
                                </button>
                                <button class="btn btn-secondary" on:click={removePaymentCustomer}>Remove</button>
                            </div>
                        </div>
                    {:else}
                        <div class="flex items-center justify-center text-sm text-text-muted border border-dashed border-border-flat rounded-md">No customer selected</div>
                    {/if}
                </section>
            {/if}

            <div class="payment-body flex flex-col md:flex-row gap-3 md:gap-4 min-h-0">
                <div class="payment-summary flex-1 flex flex-col gap-3 min-h-0">
                    <div
                        class="payment-total-card flex justify-between items-center p-3 md:p-4 bg-bg-panel rounded-sm border border-border-flat"
                    >
                        <span class="text-sm md:text-base text-text-muted"
                            >Total to Pay</span
                        >
                        <span class="text-2xl md:text-[2rem] font-black text-success"
                            >{formatMoney(paymentDue)}</span
                        >
                    </div>
                    {#if loyaltyCreditUsed > 0}
                        <div class="flex justify-between text-sm text-success px-2">
                            <span>Order {formatMoney(total)} minus loyalty credit</span>
                            <strong>-{formatMoney(loyaltyCreditUsed)}</strong>
                        </div>
                    {/if}

                    <div class="payment-methods flex gap-2">
                        <button
                            class="flat-card flex-1 p-2.5 text-sm md:text-base font-bold cursor-pointer flex justify-center items-center gap-2 {paymentMethod ===
                            'cash'
                                ? '!bg-accent-primary !text-white !border-accent-primary'
                                : ''}"
                            on:click={() => selectPaymentMethod("cash")}
                            >Cash</button
                        >
                        <button
                            class="flat-card flex-1 p-2.5 text-sm md:text-base font-bold cursor-pointer flex justify-center items-center gap-2 {paymentMethod ===
                            'card'
                                ? '!bg-accent-primary !text-white !border-accent-primary'
                                : ''}"
                            on:click={() => selectPaymentMethod("card")}
                            >Card</button
                        >
                    </div>

                    {#if paymentMethod === "cash"}
                        <div class="payment-quick-grid grid grid-cols-2 gap-2">
                            <button
                                class="payment-quick-button payment-quick-full flat-card flex flex-col items-center justify-center gap-0.5 p-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled={isCompletingSale}
                                on:click={() => setAmountAndComplete(paymentDue)}
                            >
                                <div class="text-sm font-black">Pay Full</div>
                                <div class="text-xs text-text-muted">(Exact)</div>
                            </button>
                            {#if nextPoundAmount !== null}
                                <button
                                    class="payment-quick-button flat-card flex flex-col items-center justify-center gap-0.5 p-2 cursor-pointer !border-success disabled:opacity-50 disabled:cursor-not-allowed"
                                    disabled={isCompletingSale}
                                    on:click={() =>
                                        setAmountAndComplete(nextPoundAmount!)}
                                >
                                    <div class="text-sm font-black text-success">
                                        {formatMoney(nextPoundAmount)}
                                    </div>
                                    <div class="text-[0.7rem] text-text-muted">
                                        Chg: {formatMoney(nextPoundAmount - paymentDue)}
                                    </div>
                                </button>
                            {/if}
                            {#each fixedQuickAmounts as amt}
                                <button
                                    class="payment-quick-button flat-card flex flex-col items-center justify-center gap-0.5 p-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                    disabled={isCompletingSale}
                                    on:click={() => addQuickAmount(amt)}
                                >
                                    <div class="text-sm font-black">
                                        + {formatMoney(amt)}
                                    </div>
                                </button>
                            {/each}
                        </div>
                    {:else}
                        <div class="payment-card-note min-h-[52px] text-xs text-text-muted leading-snug rounded-sm bg-bg-panel border border-border-flat p-2">
                            {#if paymentInputAmount > 0 && paymentInputAmount < paymentDue}
                                <p>Cash part locked: {formatMoney(paymentInputAmount)}. Card will take {formatMoney(paymentDue - paymentInputAmount)}.</p>
                                <button class="mt-1 underline text-accent-primary font-bold" on:click={() => selectPaymentMethod("cash")}>Edit cash part</button>
                            {:else}
                                <p>Full card payment. For split payment, enter the cash amount on Cash first, then choose Card.</p>
                            {/if}
                        </div>
                    {/if}

                    <div class="payment-result-actions flex flex-col gap-2 mt-auto">
                        {#if paymentMethod === "cash"}
                            {#if paymentInputAmount >= paymentDue}
                                <div
                                    class="payment-status-line min-h-[52px] flex items-center justify-center text-center text-lg md:text-xl font-black text-warning p-2 bg-bg-panel rounded-sm"
                                >
                                    Change: {formatMoney(
                                        paymentInputAmount - paymentDue,
                                    )}
                                </div>
                            {:else if paymentInputAmount > 0}
                                <div
                                    class="payment-status-line min-h-[52px] flex items-center justify-center text-center text-lg md:text-xl font-black text-danger p-2 bg-bg-panel rounded-sm"
                                >
                                    Remaining: {formatMoney(
                                        paymentDue - paymentInputAmount,
                                    )}
                                </div>
                            {:else}
                                <div
                                    class="payment-status-line min-h-[52px] flex items-center justify-center text-center text-xl font-black text-warning p-2 bg-bg-panel rounded-sm invisible"
                                >
                                    Change: £0.00
                                </div>
                            {/if}
                        {:else if paymentInputAmount > 0 && paymentInputAmount < paymentDue}
                            <div
                                class="payment-status-line min-h-[52px] flex items-center justify-center text-center text-xl font-black text-warning p-2 bg-bg-panel rounded-sm"
                            >
                                Card remaining: {formatMoney(
                                    paymentDue - paymentInputAmount,
                                )}
                            </div>
                        {:else if cardCashPartInvalid}
                            <div
                                class="payment-status-line min-h-[52px] flex items-center justify-center text-center text-base md:text-lg font-black text-danger p-2 bg-bg-panel rounded-sm"
                            >
                                Cash part must be less than total
                            </div>
                        {:else}
                            <div
                                class="payment-status-line min-h-[52px] flex items-center justify-center text-center text-xl font-black text-warning p-2 bg-bg-panel rounded-sm invisible"
                            >
                                Change: £0.00
                            </div>
                        {/if}
                        <button
                            class="payment-complete-btn btn btn-success w-full p-3 text-lg md:text-xl disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                            disabled={paymentCompleteDisabled}
                            on:click={completeSale}
                        >
                            {isCompletingSale ? 'Saving Sale…' : 'Complete Sale'}
                        </button>
                    </div>
                </div>

                <div
                    class="payment-pad w-full md:w-full flex flex-col bg-bg-panel p-2.5 md:p-3 rounded-md"
                >
                    <div class="flex gap-2 mb-2">
                        <div class="np-display payment-display flex-1 !h-14 md:!h-16 !text-2xl md:!text-[2rem]">
                            {formatMoney(paymentInputAmount)}
                        </div>
                        <button
                            class="np-btn np-clear w-[56px] md:w-[64px] !h-14 md:!h-16"
                            disabled={isCompletingSale}
                            on:click={clearPaymentInput}>C</button
                        >
                    </div>
                    <div class="np-grid payment-np-grid {paymentMethod === 'card' || isCompletingSale ? 'opacity-35 pointer-events-none' : ''}">
                        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"] as key}
                            <button
                                class="np-btn payment-np-button !h-14 md:!h-[68px] !text-xl md:!text-2xl {key === '⌫'
                                    ? '!text-warning'
                                    : ''}"
                                disabled={isCompletingSale}
                                on:click={() => handlePaymentPadKey(key)}
                            >
                                {key}
                            </button>
                        {/each}
                    </div>
                </div>
            </div>
        </div>
    </div>
{/if}

<!-- Held Orders Modal -->
{#if showHeldOrders}
    <div class="modal-overlay" on:click={() => (showHeldOrders = false)}>
        <div
            class="w-[420px] max-w-[95vw] max-h-[85vh] md:max-h-[90vh] overflow-y-auto p-4 sm:p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-4"
            on:click|stopPropagation
        >
            <div class="modal-header">
                <h3>Held Orders ({heldOrdersForTill.length})</h3>
                <button
                    class="modal-close"
                    on:click={() => (showHeldOrders = false)}>✕</button
                >
            </div>
            <div class="overflow-y-auto flex flex-col gap-2">
                {#each heldOrdersForTill as ho}
                    {@const lines = heldOrderLinesByOrder.get(ho.id) || []}
                    <div
                        class="flat-card p-4 cursor-pointer flex flex-col gap-2 hover:border-accent-primary {cart.length >
                        0
                            ? 'opacity-50 cursor-not-allowed grayscale hover:!border-border-flat'
                            : ''}"
                        on:click={() => retrieveOrder(ho.id)}
                    >
                        <div class="flex justify-between items-center">
                            <strong>Held Order</strong>
                            <span class="text-text-muted text-[0.8rem]"
                                >{new Date(ho.createdAt).toLocaleTimeString(
                                    "en-GB",
                                    { hour: "2-digit", minute: "2-digit" },
                                )}</span
                            >
                        </div>
                        <div class="flex flex-wrap gap-1">
                            {#each lines.slice(0, 3) as l}<span
                                    class="text-[0.8rem] text-text-muted"
                                    >{getScaleSaleDisplay(l.notes, l.quantity, l.unitPrice, l.originalPrice).label} {l.productName}</span
                                >{/each}
                            {#if lines.length > 3}<span
                                    class="text-[0.8rem] text-text-muted"
                                    >+{lines.length - 3} more...</span
                                >{/if}
                        </div>
                        <div class="text-right text-[1.1rem] money">
                            {formatMoney(ho.total)}
                        </div>
                    </div>
                {/each}
                {#if heldOrdersLoading}<p
                        class="text-center text-text-muted p-5"
                    >
                        Loading held orders...
                    </p>{/if}
                {#if !heldOrdersLoading && heldOrdersForTill.length === 0}<p
                        class="text-center text-text-muted p-5"
                    >
                        No held orders
                    </p>{/if}
            </div>
        </div>
    </div>
{/if}

<!-- Recent Transactions Modal -->
{#if showRecentTransactions}
    <div
        class="modal-overlay"
        on:click={() => (showRecentTransactions = false)}
    >
        <div
            class="w-[900px] max-w-[95vw] max-h-[85vh] md:max-h-[95vh] overflow-y-auto p-4 sm:p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-5"
            on:click|stopPropagation
        >
            <div
                class="flex justify-between items-center border-b border-border-flat pb-4"
            >
                <h2 class="m-0 text-text-main text-[1.5rem]">
                    Recent Transactions
                </h2>
                <button
                    class="modal-close"
                    on:click={() => (showRecentTransactions = false)}>✕</button
                >
            </div>

            <div class="flex flex-col md:flex-row gap-4 md:gap-6 h-auto md:h-[65vh] min-h-0">
                <div
                    class="flex-1 md:overflow-y-auto flex flex-col gap-2 md:border-r border-border-flat md:pr-4 max-h-[30vh] md:max-h-none"
                >
                    {#if recentTransactionsLoading}
                        <p class="text-center text-text-muted p-5">
                            Loading recent receipts...
                        </p>
                    {/if}
                    {#each recentOrders as ro}
                        <button
                            class="flat-card p-4 flex justify-between items-center cursor-pointer text-left hover:border-accent-primary {selectedRecentOrderId ===
                            ro.id
                                ? '!border-accent-primary !bg-accent-primary/10'
                                : ''}"
                            on:click={() => (selectedRecentOrderId = ro.id)}
                        >
                            <div class="flex flex-col gap-1">
                                <strong>Receipt #{ro.orderNumber}</strong>
                                <span class="text-[0.85rem] text-text-muted"
                                    >{new Date(
                                        ro.completedAt,
                                    ).toLocaleString("en-GB", {
                                        day: "2-digit",
                                        month: "2-digit",
                                        year: "2-digit",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                    })}</span
                                >
                                <span class="text-[0.75rem] text-text-muted">
                                    {ro.tillName || registerById.get(ro.tillNumber)?.name || ro.tillNumber || "Unknown till"}
                                    · {ro.cashierName || employeeById.get(ro.employeeId)?.name || "Unknown cashier"}
                                </span>
                            </div>
                            <div
                                class="font-bold text-[1.2rem] text-right {ro.type ===
                                'return'
                                    ? 'text-danger'
                                    : ro.status === 'completed'
                                    ? 'text-success'
                                    : 'text-warning'}"
                            >
                                {formatMoney(ro.total)}
                                <div class="text-[0.75rem]">
                                    {ro.type === "return"
                                        ? ro.notes?.startsWith("Void of receipt")
                                            ? "void"
                                            : "refund"
                                        : ro.status}
                                </div>
                            </div>
                        </button>
                    {/each}
                    {#if !recentTransactionsLoading && recentOrders.length === 0}
                        <p class="text-center text-text-muted p-5">
                            No recent receipts
                        </p>
                    {/if}
                </div>

                <div class="flex-1 flex flex-col gap-3 min-h-[350px] md:min-h-0">
                    {#if selectedRecentOrderId}
                        {@const selectedOrder = recentOrders.find(
                            (o) => o.id === selectedRecentOrderId,
                        )}
                        {#if selectedOrder}
                            <div class="receipt-paper flex justify-center">
                                <div class="receipt-print-target">
                                    <Receipt
                                        store={$storeDB}
                                        order={selectedOrder}
                                        lines={getCachedReceiptLines(selectedRecentOrderId)
                                            .map((line) => ({
                                                ...line,
                                                sku: productById.get(line.productId)?.sku || '',
                                            }))}
                                        cashierName={selectedOrder.cashierName || employeeById.get(selectedOrder.employeeId)?.name || ''}
                                        tillName={selectedOrder.tillName || registerById.get(selectedOrder.tillNumber)?.name || ''}
                                        design={receiptDesign}
                                    />
                                </div>
                            </div>
                            <div class="flex flex-col gap-2">
                                <button
                                    class="btn btn-primary w-full"
                                    disabled={isReversingOrder}
                                    on:click={printReceipt}>Print Receipt</button
                                >
                            {#if selectedOrder.type !== "return" && ["completed", "partially_refunded"].includes(selectedOrder.status)}
                                <div class="flex gap-2">
                                    <button
                                        class="btn flex-1 !text-warning"
                                        disabled={isReversingOrder}
                                        on:click={() =>
                                            requestReversal(selectedOrder.id, true, false)}
                                        >Partial Ref</button
                                    >
                                    <button
                                        class="btn flex-1 !text-warning"
                                        disabled={isReversingOrder}
                                        on:click={() =>
                                            requestReversal(
                                                selectedOrder.id,
                                                false,
                                                false,
                                            )}>{selectedOrder.status === "partially_refunded" ? "Refund Remaining" : "Refund"}</button
                                    >
                                    {#if selectedOrder.status === "completed"}
                                        <button
                                            class="btn flex-1 !text-danger"
                                            disabled={isReversingOrder}
                                            on:click={() =>
                                                requestReversal(selectedOrder.id, false, true)}
                                            >Void</button
                                        >
                                    {/if}
                                </div>
                            {/if}
                            </div>
                        {/if}
                    {/if}
                </div>
            </div>
        </div>
    </div>
{/if}

{#if showNotFoundModal}
    <div class="modal-overlay" on:click={() => (showNotFoundModal = false)}>
        <div
            class="w-[320px] max-w-[95vw] max-h-[90vh] overflow-y-auto p-6 rounded-md bg-bg-card border-2 border-danger flex flex-col gap-4"
            on:click|stopPropagation
        >
            <div class="modal-header">
                <h3 class="text-danger">Product Not Found</h3>
                <button
                    class="modal-close text-danger hover:text-white hover:bg-danger"
                    on:click={() => (showNotFoundModal = false)}>✕</button
                >
            </div>
            <div class="text-center py-2">
                <div
                    class="w-16 h-16 mx-auto mb-4 rounded-full bg-danger/10 border-2 border-danger flex items-center justify-center"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="w-8 h-8 text-danger"
                    >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                </div>
                <p class="mb-1 text-[1.1rem] text-danger font-bold">
                    Barcode Not Found
                </p>
                <p class="mb-5 text-[0.9rem] text-text-muted">
                    <code class="bg-bg-panel px-2 py-0.5 rounded text-text-main font-mono">{notFoundBarcode}</code>
                </p>
                <div class="flex flex-col gap-2">
                    <button
                        class="btn btn-primary h-[50px] text-base"
                        on:click={openQuickAdd}
                    >
                        Add New Product
                    </button>
                    <button
                        class="btn h-[50px] text-base"
                        on:click={() => (showNotFoundModal = false)}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    </div>
{/if}

{#if showQuickAddModal}
    <div class="modal-overlay" on:click={() => (showQuickAddModal = false)}>
        <div
            class="w-[920px] max-w-[97vw] max-h-[calc(100vh-1rem)] p-5 sm:p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-5"
            on:click|stopPropagation
        >
            <div class="modal-header">
                <h3>Quick Add Product</h3>
                <button
                    class="modal-close"
                    on:click={() => (showQuickAddModal = false)}>✕</button
                >
            </div>

            <div class="grid grid-cols-1 min-[700px]:grid-cols-[1fr_0.9fr] gap-6 min-h-0">
                <div class="grid grid-cols-1 sm:grid-cols-2 min-[700px]:grid-cols-1 gap-4 content-start">
                    <div class="input-group">
                        <label for="qa-name">Product Name *</label>
                        <input
                            id="qa-name"
                            type="text"
                            bind:value={quickAddName}
                            placeholder="Enter name..."
                            class="flat-input !py-3.5 !text-lg"
                            autofocus
                        />
                    </div>

                    <div class="input-group">
                        <label for="qa-sku">SKU <span class="font-normal">(optional)</span></label>
                        <input
                            id="qa-sku"
                            type="text"
                            bind:value={quickAddSku}
                            placeholder="Leave blank if not needed"
                            class="flat-input !py-3.5 !text-lg"
                        />
                    </div>

                    <div class="input-group">
                        <CustomSelect
                            label="Category *"
                            bind:value={quickAddCategoryId}
                            options={$activeCategories.map((c) => ({
                                label: c.name,
                                value: c.id,
                            }))}
                        />
                    </div>

                    <div class="input-group">
                        <CustomSelect
                            label="Tax Rate"
                            bind:value={quickAddTaxRateId}
                            options={$taxRatesDB.map((t) => ({
                                label: t.name,
                                value: t.id,
                            }))}
                        />
                    </div>
                </div>

                <div class="flex flex-col gap-2">
                    <label class="text-[0.9rem] font-semibold text-text-muted">Price *</label>
                    <div class="h-16 flex items-center justify-end px-5 text-[2rem] font-bold font-serif bg-bg-panel border border-border-flat rounded-sm">
                        {formatMoney(parseInt(quickAddPrice) || 0)}
                    </div>
                    <div class="grid grid-cols-3 gap-3">
                        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "00"] as key}
                            <button
                                class="h-14 flex items-center justify-center text-2xl font-semibold text-text-main bg-bg-panel border border-border-flat rounded-sm hover:bg-bg-card-hover transition-colors {key === 'C' ? 'np-clear' : ''}"
                                on:click={() => handleQuickAddPriceKey(key)}
                            >
                                {key}
                            </button>
                        {/each}
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-1 min-[700px]:grid-cols-2 gap-3">
                <button
                    class="btn btn-success h-16 text-lg"
                    disabled={quickAddBusy}
                    on:click={() => saveQuickProduct(false)}
                >
                    {quickAddBusy ? "Saving..." : "Save & Add to Cart"}
                </button>
                <button
                    class="btn btn-primary h-16 text-lg"
                    disabled={quickAddBusy}
                    on:click={() => saveQuickProduct(true)}
                >
                    {quickAddBusy ? "Saving..." : "Save, Add & Print Label"}
                </button>
            </div>
        </div>
    </div>
{/if}

{#if showManagerApprovalModal}
    <div class="modal-overlay">
        <div
            class="w-[520px] max-w-[95vw] max-h-[95vh] overflow-y-auto rounded-md border border-border-flat bg-bg-card p-5 flex flex-col gap-4"
            on:click|stopPropagation
        >
            <div>
                <h2 class="m-0 text-xl">Manager Approval</h2>
                <p class="mt-1 text-sm text-text-muted">
                    {managerApprovalTitle || permissionLabels[managerApprovalPermission]} needs approval before continuing.
                </p>
            </div>
            {#if managerApprovers.length === 0}
                <div class="rounded-xl border border-danger/40 bg-danger/10 p-4 text-danger">
                    No active manager or admin has this permission. Update Role Permissions in Settings.
                </div>
            {:else}
                <CustomSelect
                    label="Approving manager"
                    bind:value={managerApprovalEmployeeId}
                    options={managerApprovers.map((employee) => ({ label: `${employee.name} (${employee.role})`, value: employee.id }))}
                />
                <TouchDigitPad
                    bind:value={managerApprovalPin}
                    masked={true}
                    maxLength={8}
                    submitLabel="Approve"
                    submitDisabled={managerApprovalPin.length < 4}
                    onSubmit={approveManagerAction}
                />
                <p class="min-h-5 text-sm font-semibold text-danger">{managerApprovalError}</p>
            {/if}
            <button
                class="btn btn-secondary"
                on:click={() => {
                    showManagerApprovalModal = false;
                    managerApprovalPin = "";
                    managerApprovalError = "";
                    managerApprovalAction = null;
                }}
            >
                Cancel
            </button>
        </div>
    </div>
{/if}

{#if showPartialRefundPad && pendingReversal}
    <div class="modal-overlay">
        <div
            class="w-[430px] max-w-[95vw] max-h-[95vh] overflow-y-auto p-5 rounded-md bg-bg-card border border-border-flat flex flex-col gap-4"
            on:click|stopPropagation
        >
            <div>
                <h2 class="m-0 text-xl">Partial Refund</h2>
                <p class="text-text-muted mt-1">
                    Enter the refund amount in pounds. The amount must be smaller than the remaining balance.
                </p>
            </div>
            <TouchDigitPad
                bind:value={partialRefundInput}
                allowDecimal={true}
                maxLength={9}
                placeholder="Enter amount, for example 3.33"
                submitLabel={isReversingOrder ? "Processing..." : "Review Refund"}
                submitDisabled={isReversingOrder || toPence(Number(partialRefundInput || 0)) <= 0}
                onSubmit={reviewPartialRefund}
            />
            <button
                class="btn btn-secondary"
                disabled={isReversingOrder}
                on:click={() => {
                    showPartialRefundPad = false;
                    pendingReversal = null;
                    partialRefundInput = "";
                }}>Cancel</button
            >
        </div>
    </div>
{/if}

<ConfirmDialog
    bind:show={showClearConfirm}
    title="Clear Order?"
    message="This will remove all items from the trolley. Are you sure?"
    variant="danger"
    on:confirm={confirmClear}
/>

<ConfirmDialog
    bind:show={showReversalConfirm}
    title={pendingReversal?.voiding ? "Void This Sale?" : "Confirm Refund?"}
    message={pendingReversal?.voiding
        ? "This will void the complete sale, restore stock originally deducted, and record a reversal. This action cannot be undone."
        : pendingReversal?.partial
            ? `Refund ${formatMoney(toPence(Number(partialRefundInput || 0)))} from this sale? This action cannot be undone.`
            : "This will refund the remaining sale balance and restore stock originally deducted. This action cannot be undone."}
    confirmText={isReversingOrder ? "Processing..." : pendingReversal?.voiding ? "Void Sale" : "Confirm Refund"}
    variant="danger"
    on:confirm={confirmPendingReversal}
    on:cancel={() => {
        pendingReversal = null;
        partialRefundInput = "";
    }}
/>

<style>
    .login-form { min-height: 560px; }
    .login-pin-layout { min-height: 430px; display: grid; grid-template-columns: minmax(220px, .8fr) minmax(300px, 1fr); align-items: stretch; gap: 1rem; }
    .login-person { min-height: 430px; padding: 1.25rem; display: flex; flex-direction: column; gap: .35rem; border: 1px solid var(--border-flat); border-radius: .8rem; background: var(--bg-panel); }
    .login-person > span { color: var(--accent-primary); font-size: .68rem; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    .login-person > strong { font-size: 1.6rem; }
    .login-person > small, .login-person > p { color: var(--text-muted); }
    .login-error { min-height: 2.75rem; color: var(--danger) !important; }
    .login-pin-layout :global(.digit-pad) { min-height: 430px; }
    @media (max-width: 650px) {
        .login-form { min-height: auto; }
        .login-pin-layout { min-height: 0; grid-template-columns: 1fr; }
        .login-person { min-height: 0; }
        .login-person p:not(.login-error) { display: none; }
    }
    .scale-workspace { width: 98vw; max-width: 1180px; height: calc(100vh - .75rem); max-height: 760px; overflow: hidden; display: flex; flex-direction: column; border: 1px solid var(--border-flat); border-radius: 1rem; background: var(--bg-base); box-shadow: 0 24px 80px var(--shadow); }
    .scale-header { padding: .75rem 1rem; display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border-flat); background: var(--bg-card); }
    .scale-header h2 { margin: .1rem 0; font-size: 1.55rem; }
    .scale-header p { margin: 0; color: var(--text-muted); font-size: .85rem; }
    .scale-kicker { color: var(--success); font-size: .65rem; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    .scale-close { width: 2.5rem; height: 2.5rem; border-radius: .6rem; }
    .scale-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(300px, .75fr); }
    .scale-products { min-height: 0; padding: .75rem; display: flex; flex-direction: column; gap: .65rem; }
    .scale-page-tabs { display: flex; gap: .4rem; overflow-x: auto; min-height: 38px; padding-bottom: .1rem; }
    .scale-page-tabs button { min-height: 36px; padding: 0 .75rem; display: flex; align-items: center; gap: .4rem; white-space: nowrap; color: var(--text-main); font-size: .75rem; font-weight: 800; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-card); }
    .scale-page-tabs button i { width: .5rem; height: .5rem; border-radius: 50%; background: var(--scale-page-color); }
    .scale-products .flat-input, .scale-products .search-input { padding-top: .65rem; padding-bottom: .65rem; }
    .scale-product-grid { min-height: 0; flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(3, minmax(92px, 1fr)); gap: .55rem; }
    .scale-product { position: relative; min-height: 92px; padding: .7rem; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-start; gap: .15rem; color: var(--text-main); text-align: left; border: 2px solid var(--border-flat); border-radius: .7rem; background: var(--bg-card); }
    .scale-product i { position: absolute; z-index: 2; inset: 0 auto 0 0; width: 6px; background: var(--scale-color); }
    .scale-product-photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .scale-product-shade { position: absolute; inset: 0; background: linear-gradient(to top, rgba(15, 23, 42, .82), rgba(15, 23, 42, .25), rgba(15, 23, 42, .05)); }
    .scale-product-content { position: relative; z-index: 1; display: flex; min-width: 0; flex-direction: column; gap: .12rem; }
    .scale-product strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .scale-product span, .scale-product small { color: var(--text-muted); font-size: .75rem; }
    .scale-product.with-image strong, .scale-product.with-image span, .scale-product.with-image small { color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, .45); }
    .scale-product.selected { border-color: var(--success); background: rgba(16, 185, 129, .10); }
    .scale-pagination { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: var(--text-muted); font-size: .72rem; }
    .scale-pagination div { display: flex; align-items: center; gap: .4rem; }
    .scale-pagination button { min-height: 34px; padding: 0 .65rem; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-card); color: var(--text-main); font-size: .72rem; font-weight: 800; }
    .scale-pagination button:disabled { opacity: .3; }
    .scale-entry { padding: .7rem; min-height: 0; overflow: hidden; display: grid; grid-template-rows: 72px 42px 64px 66px minmax(190px, 1fr) 52px 48px; gap: .38rem; border-left: 1px solid var(--border-flat); background: var(--bg-panel); }
    .scale-selected, .scale-display, .scale-live, .scale-total { padding: .6rem .7rem; display: flex; flex-direction: column; gap: .1rem; border: 1px solid var(--border-flat); border-radius: .6rem; background: var(--bg-card); }
    .scale-selected span, .scale-display span, .scale-live span, .scale-total span { color: var(--text-muted); font-size: .7rem; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    .scale-selected { min-width: 0; min-height: 0; overflow: hidden; }
    .scale-selected strong, .scale-selected small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scale-selected strong { line-height: 1.15; }
    .scale-selected small { color: var(--text-muted); line-height: 1.2; }
    .scale-units { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; }
    .scale-units button { min-height: 42px; padding: .48rem; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-card); color: var(--text-main); font-weight: 700; }
    .scale-display strong { font-size: 1.55rem; text-align: right; line-height: 1.1; }
    .scale-display small { font-size: .9rem; color: var(--text-muted); }
    .scale-live { min-height: 0; flex-direction: row; align-items: center; justify-content: space-between; gap: .6rem; }
    .scale-live div { min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
    .scale-live small { color: var(--text-muted); font-size: .74rem; line-height: 1.2; word-break: break-word; }
    .scale-live button { min-height: 40px; padding: 0 .7rem; white-space: nowrap; }
    .scale-numpad { min-height: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(4, minmax(44px, 1fr)); gap: .42rem; }
    .scale-numpad button { min-height: 44px; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-card); color: var(--text-main); font-size: 1.28rem; font-weight: 900; }
    .scale-total { margin-top: 0; flex-direction: row; align-items: center; justify-content: space-between; }
    .scale-total strong { color: var(--success); font-size: 1.45rem; }
    .scale-add { min-height: 48px; height: auto; font-size: .95rem; box-shadow: 0 10px 24px var(--shadow); }
    .scale-empty { padding: 2rem; color: var(--text-muted); text-align: center; border: 1px dashed var(--border-flat); border-radius: .8rem; }
    @media (max-width: 880px) { .scale-layout { grid-template-columns: 1fr 310px; } .scale-product-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 1040px) and (max-height: 820px) {
        .scale-workspace { width: calc(100vw - .5rem); height: calc(100vh - .5rem); max-height: calc(100vh - .5rem); }
        .scale-layout { grid-template-columns: minmax(0, 1fr) minmax(270px, .7fr); }
        .scale-entry { padding: .5rem; grid-template-rows: 64px 40px 56px 58px minmax(178px, 1fr) 46px 46px; gap: .35rem; }
        .scale-selected, .scale-display, .scale-live, .scale-total { padding: .45rem .55rem; }
        .scale-product { padding: .55rem; }
        .scale-product span, .scale-product small { font-size: .68rem; }
        .scale-display strong, .scale-total strong { font-size: 1.2rem; }
        .scale-product-grid { grid-template-rows: repeat(3, minmax(78px, 1fr)); }
        .scale-product { min-height: 78px; }
        .scale-live { min-height: 0; }
        .scale-live button { min-height: 38px; padding: 0 .5rem; }
        .scale-numpad { min-height: 0; gap: .32rem; }
        .scale-numpad button { min-height: 40px; font-size: 1.15rem; }
    }
    @media (max-height: 690px) {
        .scale-workspace { height: calc(100vh - .5rem); max-height: calc(100vh - .5rem); }
        .scale-header p, .scale-selected small { display: none; }
        .scale-header { padding: .45rem .8rem; }
        .scale-products { padding: .5rem; gap: .3rem; }
        .scale-entry { padding: .5rem; grid-template-rows: 48px 38px 50px 50px minmax(160px, 1fr) 42px 44px; gap: .3rem; }
        .scale-page-tabs { min-height: 34px; }
        .scale-page-tabs button { min-height: 32px; padding: 0 .55rem; }
        .scale-products .flat-input, .scale-products .search-input { padding-top: .45rem; padding-bottom: .45rem; }
        .scale-numpad { min-height: 0; gap: .28rem; }
        .scale-numpad button { min-height: 38px; font-size: 1.05rem; }
        .scale-add { min-height: 42px; }
    }
    @media (max-width: 760px) {
        .scale-layout { grid-template-columns: 1fr; overflow-y: auto; }
        .scale-products { min-height: 420px; }
        .scale-entry { overflow: visible; border-left: 0; border-top: 1px solid var(--border-flat); }
    }
</style>
