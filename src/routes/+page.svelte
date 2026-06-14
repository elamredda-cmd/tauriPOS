<script lang="ts">
    import { onMount, tick } from "svelte";
    import { get } from "svelte/store";
    import { goto } from "$app/navigation";
    import { getCurrentWindow } from "@tauri-apps/api/window";
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
        heldOrders,
        discountsDB,
        promoGroupsDB,
        promoGroupItemsDB,
        formatMoney,
        toPence,
        now,
        uuid,
        settingsDB,
        type Customer,
        type Employee,
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
        hydrateSvelteStores,
        ensureOpenShift,
        findOpenShiftForRegister,
        retireOpenShiftsBefore,
        ensureTillReceiptSequence,
        type SaleBundle,
    } from "$lib/stores/database";
    import { evaluateCart, type CartEvaluation } from "$lib/utils/discountEngine";
    import { calculateCartTotals, calculateTaxLine } from "$lib/utils/commerceMath";
    import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
    import CustomSelect from "$lib/components/CustomSelect.svelte";
    import Receipt from "$lib/components/Receipt.svelte";
    import { getReceiptDesign } from "$lib/receipt";
    import { authenticateEmployeePin, canManage, currentEmployee, currentShiftId, logout } from "$lib/stores/session";
    import { connectionState } from "$lib/stores/connection";
    import { getBarcodeRules, parseScaleBarcode } from "$lib/barcodeRules";
    import { getScaleSaleDisplay } from "$lib/scaleSale";
    import { getLoyaltyConfig, loyaltyCredit, pointsForCredit, pointsForSpend } from "$lib/loyalty";
    import TouchDigitPad from "$lib/components/TouchDigitPad.svelte";
    import { broadcastCustomerDisplay, type CustomerDisplayState } from "$lib/customerDisplay";
    import { allocateRefundLines, allocateRefundPayment, getRemainingRefundAmount } from "$lib/refunds";
    import { sendCctvItemAdded, sendCctvReceipt } from "$lib/cctvPos";

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
    let showMenu = false;
    let showHeldOrders = false;
    let showPaymentModal = false;
    let showDiscountModal = false;
    let selectedManualDiscountId = "";
    let paymentMethod: "cash" | "card" = "cash";
    let amountTenderedString = "0";
    let hasTypedPayment = false;
    let cartItemEls: HTMLElement[] = [];
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
    const SCALE_PRODUCTS_PER_PAGE = 9;
    const MAX_SCALE_WEIGHT_DIGITS = 6;
    const MAX_ORDER_TOTAL_PENCE = 999_999_999;
    let quickAddName = "";
    let quickAddSku = "";
    let quickAddPrice = "0";
    let quickAddCategoryId = "";
    let quickAddTaxRateId = "";
    let showClearConfirm = false;
    let showReversalConfirm = false;
    let showPartialRefundPad = false;
    let pendingReversal: { orderId: string; partial: boolean; voiding: boolean } | null = null;
    let partialRefundInput = "";
    let isReversingOrder = false;
    let isCompletingSale = false;
    let isHoldingOrder = false;
    let isFullscreen = false;
    let fullscreenBusy = false;
    let selectedLoginEmployeeId = "";
    let loginPin = "";
    let loginError = "";
    let pendingShiftEmployee: Employee | null = null;
    let openingFloatString = "0";
    let lastRevokedEmployeeId = "";
    $: activeLoginEmployees = $employeesDB
        .filter((employee) => employee.isActive)
        .sort((a, b) => a.name.localeCompare(b.name));
    $: selectedLoginEmployee = activeLoginEmployees.find((employee) => employee.id === selectedLoginEmployeeId) || null;
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
    $: syncLabel = $connectionState.mode === "single"
        ? "Local"
        : $connectionState.mode === "multi"
            ? ($connectionState.mysqlOnline ? ($connectionState.syncError ? "Sync issue" : "Synced") : "Offline")
            : "Setup";
    $: syncStyle = syncLabel === "Synced"
        ? "text-success border-success/40 bg-success/10"
        : syncLabel === "Offline" || syncLabel === "Sync issue"
            ? "text-danger border-danger/40 bg-danger/10"
            : "text-text-muted border-border-flat bg-bg-card";

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

    const cartLayoutDefault = ['goods', 'recent_trans', 'change_price', 'hold'];
    const toolbarLayoutDefault = ['scale', 'label_print', 'discount'];
    const allowedCartLayoutKeys = new Set(['goods', 'recent_trans', 'change_price', 'hold', 'scale', 'discount']);
    const allowedToolbarLayoutKeys = new Set(['scale', 'label_print', 'discount', 'goods', 'recent_trans', 'change_price']);

    function parsePosLayout(value: string | undefined, fallback: string[], allowedKeys: Set<string>) {
        try {
            const parsed = JSON.parse(value || "");
            if (!Array.isArray(parsed)) return fallback;
            const valid = parsed
                .map((key) => key === "drawer" ? "label_print" : key)
                .map((key) => fallback === cartLayoutDefault && key === "label_print" ? "hold" : key)
                .filter((key): key is string => typeof key === "string" && allowedKeys.has(key));
            return valid.length > 0 ? [...new Set(valid)] : fallback;
        } catch {
            return fallback;
        }
    }

    $: cartLayout = parsePosLayout($settingsDB.find(s => s.key === 'pos_cart_layout')?.value, cartLayoutDefault, allowedCartLayoutKeys);
    $: toolbarLayout = parsePosLayout($settingsDB.find(s => s.key === 'pos_toolbar_layout')?.value, toolbarLayoutDefault, allowedToolbarLayoutKeys);
    $: stockTrackingEnabled = ($settingsDB.find(s => s.key === 'stock_tracking_enabled')?.value ?? 'true') !== 'false';
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
        product && (product.name.toLowerCase().includes(scaleSearch.toLowerCase()) || product.scalePlu?.includes(scaleSearch)),
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
            showMenu ||
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

    $: {
        if (selectedCartIndex >= 0 && cartItemEls[selectedCartIndex]) {
            cartItemEls[selectedCartIndex].scrollIntoView({
                behavior: "smooth",
                block: "nearest",
            });
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
    $: activeProductIds = new Set($activeProducts.map((product) => product.id));

    $: totalPages = Math.max(
        1,
        Math.ceil(
            (activePageTiles.length > 0
                ? Math.max(...activePageTiles.map((t) => t.position))
                : 0) / 12,
        ),
    );

    $: if (currentPageIndex >= totalPages)
        currentPageIndex = Math.max(0, totalPages - 1);

    $: displayTiles = Array.from({ length: 12 }, (_, i) => {
        const absolutePos = currentPageIndex * 12 + i + 1; // 1-indexed
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

    function openDiscounts() {
        if (cart.length === 0) {
            toast("Add an item before applying a discount", "error");
            return;
        }
        showDiscountModal = true;
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
    let currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
    });

    onMount(() => {
        refreshFullscreenState();
        const timer = setInterval(() => {
            promoClock = new Date().toISOString();
            currentTime = new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            });
        }, 60000);

        // Auto-generate and cache till identity for this machine
        getOrCreateTillId().then(async id => {
            tillId = id;
            await ensureTillReceiptSequence();
        });
        getTillName().then(name => { tillName = name; });
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
            loginPin = "";
            loginError = "";
        } catch (error) {
            console.error("Could not sign in:", error);
            logout();
            loginPin = "";
            loginError = "Could not open this till shift. Check the database connection and try again.";
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
            showMenu = false;
            return;
        }
        logout();
        selectedLoginEmployeeId = "";
        loginPin = "";
        loginError = "";
        showMenu = false;
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

    function openScale() {
        selectedScaleProductId = "";
        scaleWeightInput = "";
        scaleWeightUnit = "kg";
        scaleSearch = "";
        scalePage = 0;
        activeScaleTilePageId = scaleTilePages[0]?.id || "";
        showScaleModal = true;
    }

    function openScaleForProduct(productId: string) {
        scaleWeightInput = "";
        scaleWeightUnit = "kg";
        scaleSearch = "";
        scalePage = 0;
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
        showScaleModal = false;
        toast(`${selectedScaleProduct.name} added from scale`, "success");
    }

    async function handleSearch() {
        const query = searchQuery.trim();
        if (!query) return;
        // Clear immediately so a second fast scan cannot be overwritten when
        // this asynchronous lookup finishes.
        searchQuery = "";

        try {
            const found = await searchProduct(query);

            if (found) {
                if (found.isWeighable) {
                    openScaleForProduct(found.id);
                    return;
                }
                addToCart({
                    id: found.id,
                    name: found.name,
                    price: found.price,
                });
                return;
            }
            const parsed = parseScaleBarcode(query, getBarcodeRules($settingsDB));
            if (parsed) {
                const scaleProduct = await searchProductByScalePlu(parsed.scalePlu);
                if (!scaleProduct) {
                    toast(`No active product has Scale PLU ${parsed.scalePlu}`, "error");
                    playErrorSound();
                    return;
                }
                if (parsed.rule.valueType === "weight") {
                    const linePrice = Math.round(scaleProduct.price * parsed.value);
                    if (linePrice <= 0) {
                        toast("Weight barcode contains an invalid weight", "error");
                        playErrorSound();
                        return;
                    }
                    addToCart({
                        id: scaleProduct.id,
                        name: scaleProduct.name,
                        price: linePrice,
                        originalPrice: scaleProduct.price,
                        isPriceOverride: true,
                        sourceBarcode: parsed.rawBarcode,
                        note: `Scale weight barcode: ${Math.round(parsed.value * 1000)} g at ${formatMoney(scaleProduct.price)}/kg`,
                        forceSeparateLine: true,
                        quantityLocked: true,
                        skipStockAdjustment: true,
                    });
                    return;
                }
                addToCart({
                    id: scaleProduct.id,
                    name: scaleProduct.name,
                    price: Math.round(parsed.value * 100),
                    originalPrice: scaleProduct.price,
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

    async function saveQuickProduct() {
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

        const newProduct = {
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

        try {
            await addProduct(newProduct);
            productsDB.update((ps) => [...ps, newProduct]);
            addToCart(newProduct);
            showQuickAddModal = false;
            toast("Product added and added to cart", "success");
        } catch (error) {
            toast(String(error).replace(/^Error:\s*/, ""), "error");
        }
    }
    function handleSearchKeydown(e: KeyboardEvent) {
        if (e.key === "Enter") handleSearch();
    }

    function handlePosBackgroundClick(event: MouseEvent) {
        showMenu = false;
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
            ordersDB.update((orders) => [...orders, newOrder]);
            orderLinesDB.update((existing) => [...existing, ...lines]);
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
        const heldOrder = $ordersDB.find((order) => order.id === orderId);
        const lines = $orderLinesDB.filter((l) => l.orderId === orderId);
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
        ordersDB.update((o) => o.filter((x) => x.id !== orderId));
        orderLinesDB.update((l) => l.filter((x) => x.orderId !== orderId));
        showHeldOrders = false;
        toast("Order retrieved");
    }

    function openChangePrice() {
        if (cart[selectedCartIndex]) {
            const product = $productsDB.find((item) => item.id === cart[selectedCartIndex].id);
            if (!product?.allowPriceOverride && !canManage($currentEmployee)) {
                toast("Manager permission required to override this item price", "error");
                return;
            }
            changePriceString = cart[selectedCartIndex].price.toString();
            hasStartedTypingPrice = false;
            showChangePricePad = true;
        }
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
        if (!canManage($currentEmployee)) {
            toast("Manager permission required", "error");
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
    $: heldOrdersForTill = tillId ? $heldOrders.filter((order) => !order.tillNumber || order.tillNumber === tillId) : $heldOrders;
    $: isMenuDisabled = cart.length > 0 || heldOrdersForTill.length > 0;

    function handleMenuClick(path: string) {
        if (isMenuDisabled) {
            const msg =
                cart.length > 0
                    ? "You have products in the trolley"
                    : "You have held orders";
            toast(msg, "error");
            showMenu = false;
            return;
        }
        if ($employeesDB.length === 0) {
            showMenu = false;
            goto("/setup");
            return;
        }
        if (!canManage($currentEmployee) && !['/orders', '/shifts'].includes(path)) {
            toast("Manager permission required", "error");
            showMenu = false;
            return;
        }
        goto(path);
    }

    let showRecentTransactions = false;
    let selectedRecentOrderId: string | null = null;
    let recentTransactionsPage = 0;
    const RECENT_TRANSACTIONS_PAGE_SIZE = 25;
    $: scannerOverlayOpen =
        showNumpad ||
        showChangePricePad ||
        showGoodsModal ||
        showMenu ||
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

    async function refreshFullscreenState() {
        try {
            isFullscreen = await getCurrentWindow().isFullscreen();
        } catch {
            isFullscreen = false;
        }
    }

    async function toggleFullscreenFromMenu() {
        if (fullscreenBusy) return;
        fullscreenBusy = true;
        try {
            const appWindow = getCurrentWindow();
            const current = await appWindow.isFullscreen();
            await appWindow.setFullscreen(!current);
            isFullscreen = !current;
            showMenu = false;
        } catch (error) {
            console.error("Could not change fullscreen mode:", error);
            toast("Could not change full screen mode", "error");
        } finally {
            fullscreenBusy = false;
        }
    }
    
    $: allRecentOrders = $ordersDB
        .filter((o) => !["hold", "open"].includes(o.status))
        .sort(
            (a, b) =>
                new Date(b.completedAt).getTime() -
                new Date(a.completedAt).getTime(),
        );
    $: recentTransactionsPageCount = Math.max(1, Math.ceil(allRecentOrders.length / RECENT_TRANSACTIONS_PAGE_SIZE));
    $: if (recentTransactionsPage >= recentTransactionsPageCount) recentTransactionsPage = recentTransactionsPageCount - 1;
    $: recentOrders = allRecentOrders.slice(
        recentTransactionsPage * RECENT_TRANSACTIONS_PAGE_SIZE,
        (recentTransactionsPage + 1) * RECENT_TRANSACTIONS_PAGE_SIZE,
    );
    $: if (
        showRecentTransactions &&
        selectedRecentOrderId &&
        !recentOrders.some((order) => order.id === selectedRecentOrderId)
    ) {
        selectedRecentOrderId = recentOrders[0]?.id || null;
    }

    async function openRecentTransactions() {
        try {
            if ($connectionState.mode === "multi" && $connectionState.mysqlOnline) {
                await triggerSync();
            }
            await hydrateSvelteStores();
            await tick();
        } catch (e) {
            console.error("Failed to refresh recent transactions:", e);
            toast("Could not refresh recent transactions", "error");
        }
        recentTransactionsPage = 0;
        selectedRecentOrderId =
            allRecentOrders.length > 0 ? allRecentOrders[0].id : null;
        showRecentTransactions = true;
    }

    function printReceipt() {
        if (!selectedRecentOrderId || !recentOrders.some((order) => order.id === selectedRecentOrderId)) {
            toast("Select a receipt before printing", "error");
            return;
        }
        window.print();
    }

    async function reverseOrder(orderId: string, partial: boolean, voiding: boolean) {
        if (isReversingOrder) return;
        if (!canManage($currentEmployee)) {
            toast("Manager permission required", "error");
            return;
        }
        const original = get(ordersDB).find((o) => o.id === orderId);
        if (!original || original.type === "return" || !["completed", "partially_refunded"].includes(original.status)) {
            toast("Only completed or partially refunded sales can be reversed", "error");
            return;
        }
        const originalLines = get(orderLinesDB).filter((l) => l.orderId === orderId);
        const originalPayments = get(paymentsDB).filter((p) => p.orderId === orderId);
        if (originalLines.length === 0 || originalPayments.length === 0) {
            toast("This transaction is incomplete on this till. Sync and try again.", "error");
            return;
        }
        const originalLoyaltyChanges = get(loyaltyLogDB).filter((entry) => entry.orderId === orderId);
        const previousReversals = get(ordersDB).filter((order) =>
            order.type === "return" && order.originalOrderId === original.id
        );
        const previousReversalIds = new Set(previousReversals.map((order) => order.id));
        const previousReversalPayments = get(paymentsDB).filter((payment) =>
            previousReversalIds.has(payment.orderId)
        );
        const previousLoyaltyAdjustments = get(loyaltyLogDB).filter((entry) =>
            previousReversalIds.has(entry.orderId) && entry.reason === "refund_adjustment"
        );
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
        const originalStockMovements = get(inventoryLogDB).filter((log) =>
            log.referenceId === original.id && log.type === "sale" && log.quantityChange < 0
        );
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
            await commitSale({
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
            await hydrateSvelteStores();
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
        if (!canManage($currentEmployee)) {
            toast("Manager permission required", "error");
            return;
        }
        pendingReversal = { orderId, partial, voiding };
        partialRefundInput = "";
        if (partial) showPartialRefundPad = true;
        else showReversalConfirm = true;
    }

    function reviewPartialRefund() {
        if (!pendingReversal) return;
        const original = get(ordersDB).find((order) => order.id === pendingReversal?.orderId);
        if (!original) {
            toast("The original sale is no longer available", "error");
            return;
        }
        const previousReversals = get(ordersDB).filter((order) =>
            order.type === "return" && order.originalOrderId === original.id
        );
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
        await reverseOrder(pendingReversal.orderId, pendingReversal.partial, pendingReversal.voiding);
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
        amountTenderedString = amount.toString();
        hasTypedPayment = true;
        await tick();
        await completeSale();
    }

    async function addQuickAmount(amount: number) {
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
        paymentMethod = method;
        if (method === "card" && paymentInputAmount >= paymentDue) {
            amountTenderedString = "0";
            hasTypedPayment = false;
        }
    }

    function clearPaymentInput() {
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

        isCompletingSale = true;
        try {
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

            const committedSale = await commitSale({ order: newOrder, lines, payment, stockChanges, loyaltyChanges, audit });
            applyCompletedSaleToStores(committedSale);
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
            );
            triggerSync();
        } catch (e) {
            console.error(e);
            toast(`Sale was not completed: ${e}`, "error", true);
        } finally {
            isCompletingSale = false;
        }
    }
</script>

{#if !$currentEmployee && $employeesDB.length > 0}
    <div class="fixed inset-0 z-[1000] bg-bg-base flex items-center justify-center p-3 md:p-5">
        <form class="w-full max-w-[780px] max-h-[96vh] overflow-hidden bg-bg-card border border-border-flat rounded-md p-5 md:p-7 flex flex-col gap-4 shadow-[var(--shadow)]" on:submit|preventDefault={login}>
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
                        {#if loginError}<p class="text-danger font-semibold">{loginError}</p>{/if}
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
            class="flex justify-between items-center h-12 md:h-14 lg:h-16 mb-2 md:mb-3 lg:mb-5 shrink-0"
        >
            <div class="flex items-center gap-4">
                <div class="relative">
                    <button
                        class="w-12 h-12 rounded-md bg-bg-card border border-border-flat flex items-center justify-center hover:bg-bg-card-hover transition-colors"
                        on:click|stopPropagation={() => (showMenu = !showMenu)}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            width="24"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            ><line x1="3" y1="12" x2="21" y2="12"></line><line
                                x1="3"
                                y1="6"
                                x2="21"
                                y2="6"
                            ></line><line x1="3" y1="18" x2="21" y2="18"
                            ></line></svg
                        >
                    </button>

                    {#if showMenu}
                        <div
                            class="absolute top-14 left-0 w-[240px] flex flex-col py-2 z-50 shadow-[var(--shadow)] bg-bg-card border border-border-flat rounded-md max-h-[80vh] overflow-y-auto"
                            on:click|stopPropagation
                        >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/design")}
                                >🎨 Design Studio</button
                            >
                            <div class="h-px bg-border-flat my-1 mx-2"></div>
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/items")}
                                >📦 Items</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/categories")}
                                >📂 Categories</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/customers")}
                                >👤 Customers</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/employees")}
                                >🧑‍💼 Employees</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/suppliers")}
                                >🚚 Suppliers</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/discounts")}
                                >🏷️ Discounts</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/tax-rates")}
                                >📊 Tax Rates</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/orders")}
                                >📋 Orders</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/shifts")}
                                >⏱️ Shifts</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/reports")}
                                >📊 Reports</button
                            >
                            <button
                                class="menu-link {isMenuDisabled
                                    ? 'menu-link-disabled'
                                    : ''}"
                                on:click={() => handleMenuClick("/settings")}
                                >⚙️ Settings</button
                            >
                            <div class="h-px bg-border-flat my-1 mx-2"></div>
                            <button
                                class="menu-link"
                                disabled={fullscreenBusy}
                                on:click={toggleFullscreenFromMenu}
                                >{isFullscreen ? 'Exit Full Screen' : 'Full Screen'}</button
                            >
                            <button
                                class="menu-link !text-danger hover:!bg-danger hover:!text-white"
                                on:click={logoutEmployee}
                                >🚪 Logout</button
                            >
                        </div>
                    {/if}
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
                    <span class="font-semibold text-text-muted">{$currentEmployee?.name || 'Signed out'}</span>
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

            <h1 class="absolute left-1/2 -translate-x-1/2 text-xl md:text-2xl lg:text-3xl font-black text-text-main tracking-tight">{$storeDB.name}</h1>
            <div
                class="flex items-center gap-2 px-2.5 py-1.5 rounded-full border text-[11px] font-bold {syncStyle}"
                title={$connectionState.syncError || syncLabel}
            >
                <span class="w-2 h-2 rounded-full bg-current"></span>
                {syncLabel}
            </div>
        </header>

        <!-- POS Pages -->
        <div class="flex gap-3 overflow-x-auto pb-3 mb-5">
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
        <div class="flex flex-col gap-2 md:gap-3 lg:gap-5 flex-1 min-h-0">
            <div class="grid grid-cols-4 grid-rows-3 gap-1 md:gap-2 lg:gap-3 flex-1">
                {#each displayTiles as slot, tileIndex (`${currentPageIndex}:${tileIndex}:${slot?.tile.id || "empty"}:${slot?.product?.updatedAt || ""}:${slot?.product?.price ?? ""}`)}
                    {#if slot && slot.product}
                        {@const temporaryOffer = activeTemporaryOffer(slot.product.id, slot.product.price, currentTime)}
                        <div
                            class="relative overflow-hidden cursor-pointer bg-[var(--tile-bg)] border border-border-flat rounded-md transition-colors hover:brightness-110 flex flex-col"
                            on:click={() => slot.product!.isWeighable ? openScaleForProduct(slot.product!.id) : addToCart(slot.product!)}
                        >
                            <div
                                class="flex-1 flex items-center justify-center overflow-hidden relative"
                                style="background-color: {slot.product.color ||
                                    '#3b82f6'}"
                            >
                                {#if slot.product.image}
                                    <img
                                        src={slot.product.image}
                                        alt={slot.product.name}
                                        class="w-full h-full object-cover"
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
            <div class="flex items-center gap-1.5 md:gap-2 h-11 md:h-14 shrink-0">
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
                <div class="flex-1"></div>
                {#each toolbarLayout as btn}
                    {#if btn === 'scale'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[10px] md:text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors flex items-center justify-center" on:click={openScale}>SCALE</button>
                    {:else if btn === 'label_print'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[10px] md:text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors flex items-center justify-center" on:click={() => goto('/label-print')}>LABEL PRINT</button>
                    {:else if btn === 'discount'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[10px] md:text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors flex items-center justify-center" on:click={openDiscounts}>DISCOUNT</button>
                    {:else if btn === 'goods'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[10px] md:text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors flex items-center justify-center" on:click={openGoodsModal}>GOODS</button>
                    {:else if btn === 'recent_trans'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[8px] md:text-[8px] md:text-[10px] lg:text-xs font-bold leading-tight hover:bg-bg-card-hover transition-colors flex items-center justify-center text-center" on:click={openRecentTransactions}>RECENT<br class="hidden md:inline"/>TRANS</button>
                    {:else if btn === 'change_price'}
                        <button
                            class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[8px] md:text-[10px] font-bold leading-tight hover:bg-bg-card-hover transition-colors flex items-center justify-center text-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-card"
                            disabled={!hasSelectedCartItem}
                            on:click={openChangePrice}>CHANGE<br class="hidden md:inline"/>PRICE</button>
                    {/if}
                {/each}
            </div>
        </div>
    </main>

    <!-- Cart / Trolly -->
    <aside
        class="pos-cart flex flex-col w-64 md:w-72 lg:w-80 xl:w-96 2xl:w-[420px] bg-bg-panel border-l border-border-flat shrink-0 overflow-hidden"
    >
        <!-- Compact Trolly Header (Order info + Search + Clear) -->
        <div
            class="flex items-center gap-2 md:gap-3 p-3 md:p-4 border-b border-border-flat bg-bg-panel shrink-0"
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
        <div class="flex-1 overflow-y-auto p-2 md:p-3 flex flex-col gap-1.5 relative">
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
                <div
                    bind:this={cartItemEls[i]}
                    class="flex items-start gap-2.5 p-1.5 md:p-2.5 rounded-md border transition-all cursor-pointer group {selectedCartIndex ===
                    i
                        ? 'border-accent-primary bg-accent-primary/5 shadow-sm'
                        : 'border-border-flat bg-bg-card hover:bg-bg-card-hover'}"
                    on:click={() => (selectedCartIndex = i)}
                >
                    <div
                        class="text-xs md:text-sm font-bold text-accent-primary min-w-[20px] md:min-w-[26px] pt-0.5"
                    >
                        {scaleDisplay.label}
                    </div>
                    <div class="flex-1 min-w-0">
                        <h4
                            class="m-0 text-[11px] md:text-sm font-bold text-text-main truncate leading-tight"
                        >
                            {item.name}
                        </h4>
                        {#if item.quantityLocked}
                            <span class="text-[9px] md:text-[10px] font-bold uppercase tracking-wide text-warning">Scale label · fixed quantity</span>
                        {/if}
                        {#if item.note}
                            <span
                                class="text-[9px] text-text-muted italic block truncate mt-0.5 leading-tight"
                                >{item.note}</span
                            >
                        {/if}
                        {#if cartEval.lines[i]?.applied?.length}
                            {#each cartEval.lines[i].applied as ap}
                                {@const d = $discountsDB.find(
                                    (x) => x.id === ap.discountId,
                                )}
                                <div
                                    class="mt-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold inline-flex items-center gap-1 bg-success/10 text-success border border-success/20 leading-tight"
                                >
                                    🟢 {ap.discountName} −{formatMoney(
                                        ap.savings,
                                    )}
                                    {#if d}
                                        <small class="opacity-70 font-normal text-[8px]">
                                            {#if d.kind === "bundle_fixed_price"}
                                                (Any {d.bundleQuantity} for {formatMoney(
                                                    d.bundlePrice,
                                                )})
                                            {:else if d.kind === "bogo_fixed_price"}
                                                (Buy {d.minQuantity}, 2nd at {formatMoney(
                                                    d.secondPrice,
                                                )})
                                            {:else if d.kind === "temporary_item"}
                                                ({d.type === "percentage" ? `${d.value}% off` : `${formatMoney(d.value)} sale price`})
                                            {/if}
                                        </small>
                                    {/if}
                                </div>
                            {/each}
                        {:else if cartEval.lines[i]?.eligibleFor?.length}
                            <div
                                class="mt-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold inline-flex items-center gap-1 bg-warning/10 text-warning border border-warning/20 leading-tight"
                            >
                                🟡 Eligible:
                                {#each cartEval.lines[i].eligibleFor as el, idx}
                                    {@const d = $discountsDB.find(
                                        (x) => x.id === el.discountId,
                                    )}
                                    {el.discountName}{idx <
                                    cartEval.lines[i].eligibleFor.length - 1
                                        ? ", "
                                        : ""}
                                    {#if d}
                                        <small
                                            class="opacity-70 font-normal ml-1 text-[8px]"
                                        >
                                            {#if d.kind === "bundle_fixed_price"}
                                                (Any {d.bundleQuantity} for {formatMoney(
                                                    d.bundlePrice,
                                                )})
                                            {:else if d.kind === "bogo_fixed_price"}
                                                (Buy {d.minQuantity}, 2nd at {formatMoney(
                                                    d.secondPrice,
                                                )})
                                            {:else if d.kind === "temporary_item"}
                                                ({d.type === "percentage" ? `${d.value}% off` : `${formatMoney(d.value)} sale price`})
                                            {/if}
                                        </small>
                                    {/if}
                                {/each}
                            </div>
                        {/if}
                    </div>
                    <div class="text-right shrink-0 pt-0.5">
                        <div class="text-[9px] md:text-xs text-text-muted font-medium leading-tight">
                            {formatMoney(item.price)}
                        </div>
                        <div class="text-[10px] md:text-sm font-bold text-text-main leading-tight mt-0.5">
                            {formatMoney(item.price * item.quantity)}
                        </div>
                    </div>
                    <button
                        class="w-7 h-7 mt-0.5 flex items-center justify-center text-text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-all shrink-0"
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
        <div class="flex gap-1 md:gap-2 p-2 md:p-4 pb-0 shrink-0">
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
        <div class="px-2 md:px-4 py-1 md:py-2 shrink-0">
            {#if promoSavings > 0}
                <div
                    class="flex justify-between items-center text-sm font-bold text-success mb-1"
                >
                    <span>Promotions</span>
                    <span>−{formatMoney(promoSavings)}</span>
                </div>
            {/if}
            <div
                class="flex justify-between items-center py-3 border-y border-border-flat my-1"
            >
                <span
                    class="text-lg md:text-xl font-bold text-text-muted uppercase tracking-wider"
                    >Total</span
                >
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
        <div class="grid grid-cols-3 gap-1 md:gap-2 px-2 md:px-4 pb-2 md:pb-4 shrink-0 auto-rows-[2.5rem] md:auto-rows-[3.5rem]">
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
                {:else if btn === 'recent_trans'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[10px] font-bold leading-tight hover:bg-bg-card-hover transition-colors"
                        on:click={openRecentTransactions}>RECENT<br/>TRANS</button
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
    <div class="modal-overlay" on:click={() => (showScaleModal = false)}>
        <div class="scale-workspace" on:click|stopPropagation>
            <header class="scale-header">
                <div>
                    <span class="scale-kicker">Manual weighing</span>
                    <h2>Scale</h2>
                    <p>Select a product, enter its weight, then add the calculated total.</p>
                </div>
                <button class="modal-close scale-close" on:click={() => (showScaleModal = false)}>✕</button>
            </header>

            <div class="scale-layout">
                <section class="scale-products">
                    <div class="scale-page-tabs">
                        {#each scaleTilePages as page}
                            <button
                                class:active={page.id === activeScaleTilePageId}
                                style="--scale-page-color: {page.color}"
                                on:click={() => { activeScaleTilePageId = page.id; scalePage = 0; scaleSearch = ""; }}
                            >
                                <i></i>{page.name}
                            </button>
                        {/each}
                    </div>
                    <input class="flat-input" value={scaleSearch} on:input={(event) => { scaleSearch = event.currentTarget.value; scalePage = 0; }} placeholder="Search weighable products or PLU..." />
                    {#if visibleScaleProducts.length}
                        <div class="scale-product-grid">
                            {#each pagedScaleProducts as product}
                                {#if product}
                                    <button
                                        class="scale-product {selectedScaleProductId === product.id ? 'selected' : ''}"
                                        style="--scale-color: {product.color || '#3b82f6'}"
                                        on:click={() => (selectedScaleProductId = product.id)}
                                    >
                                        <i></i>
                                        <strong>{product.name}</strong>
                                        <span>{formatMoney(product.price)} / kg</span>
                                        {#if product.scalePlu}<small>PLU {product.scalePlu}</small>{/if}
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
                        <button class:active={scaleWeightUnit === "kg"} on:click={() => (scaleWeightUnit = "kg")}>Kilograms</button>
                        <button class:active={scaleWeightUnit === "g"} on:click={() => (scaleWeightUnit = "g")}>Grams</button>
                    </div>
                    <div class="scale-display">
                        <span>Weight</span>
                        <strong>{scaleWeightInput || "0"} <small>{scaleWeightUnit}</small></strong>
                    </div>
                    <div class="scale-numpad">
                        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"] as key}
                            <button on:click={() => handleScaleKey(key)}>{key}</button>
                        {/each}
                    </div>
                    <button class="scale-clear" on:click={() => handleScaleKey("C")}>Clear weight</button>
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
            class="w-[980px] max-w-[97vw] max-h-[95vh] overflow-y-auto p-3 md:p-5 rounded-md bg-bg-card border border-border-flat flex flex-col gap-4"
            on:click|stopPropagation
        >
            <div
                class="flex justify-between items-center border-b border-border-flat pb-4"
            >
                <h2 class="m-0 text-text-main text-xl md:text-[1.5rem]">Payment</h2>
                <button
                    class="modal-close"
                    disabled={isCompletingSale}
                    on:click={closePayment}>✕</button
                >
            </div>

            {#if loyaltyConfig.enabled}
                <section class="grid grid-cols-1 md:grid-cols-[1fr_1.1fr] gap-3 p-3 rounded-md border border-border-flat bg-bg-panel">
                    <div class="relative">
                        <label class="block text-xs font-bold text-text-muted mb-1">Scan loyalty barcode or search customer</label>
                        <input
                            bind:this={customerSearchInput}
                            class="flat-input w-full"
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

            <div class="flex flex-col md:flex-row gap-4 md:gap-6">
                <div class="flex-1 flex flex-col gap-5">
                    <div
                        class="flex justify-between items-center p-5 bg-bg-panel rounded-sm border border-border-flat"
                    >
                        <span class="text-base md:text-[1.2rem] text-text-muted"
                            >Total to Pay</span
                        >
                        <span class="text-3xl md:text-[2.2rem] font-bold text-success"
                            >{formatMoney(paymentDue)}</span
                        >
                    </div>
                    {#if loyaltyCreditUsed > 0}
                        <div class="flex justify-between text-sm text-success px-2">
                            <span>Order {formatMoney(total)} minus loyalty credit</span>
                            <strong>-{formatMoney(loyaltyCreditUsed)}</strong>
                        </div>
                    {/if}

                    <div class="flex gap-3">
                        <button
                            class="flat-card flex-1 p-3 md:p-5 text-base md:text-[1.2rem] font-semibold cursor-pointer flex justify-center items-center gap-2 {paymentMethod ===
                            'cash'
                                ? '!bg-accent-primary !text-white !border-accent-primary'
                                : ''}"
                            on:click={() => selectPaymentMethod("cash")}
                            >Cash</button
                        >
                        <button
                            class="flat-card flex-1 p-3 md:p-5 text-base md:text-[1.2rem] font-semibold cursor-pointer flex justify-center items-center gap-2 {paymentMethod ===
                            'card'
                                ? '!bg-accent-primary !text-white !border-accent-primary'
                                : ''}"
                            on:click={() => selectPaymentMethod("card")}
                            >Card</button
                        >
                    </div>

                    <div class="flex-1"></div>

                    <div class="flex flex-col gap-3 mt-auto">
                        {#if paymentMethod === "cash"}
                            {#if paymentInputAmount >= paymentDue}
                                <div
                                    class="min-h-[64px] flex items-center justify-center text-center text-xl md:text-[1.5rem] font-bold text-warning p-2 md:p-3 bg-bg-panel rounded-sm"
                                >
                                    Change: {formatMoney(
                                        paymentInputAmount - paymentDue,
                                    )}
                                </div>
                            {:else if paymentInputAmount > 0}
                                <div
                                    class="min-h-[64px] flex items-center justify-center text-center text-xl md:text-[1.5rem] font-bold text-danger p-2 md:p-3 bg-bg-panel rounded-sm"
                                >
                                    Remaining: {formatMoney(
                                        paymentDue - paymentInputAmount,
                                    )}
                                </div>
                            {:else}
                                <div
                                    class="min-h-[64px] flex items-center justify-center text-center text-[1.5rem] font-bold text-warning p-3 bg-bg-panel rounded-sm invisible"
                                >
                                    Change: £0.00
                                </div>
                            {/if}
                        {:else if paymentInputAmount > 0 && paymentInputAmount < paymentDue}
                            <div
                                class="min-h-[64px] flex items-center justify-center text-center text-[1.5rem] font-bold text-warning p-3 bg-bg-panel rounded-sm"
                            >
                                Card remaining: {formatMoney(
                                    paymentDue - paymentInputAmount,
                                )}
                            </div>
                        {:else if cardCashPartInvalid}
                            <div
                                class="min-h-[64px] flex items-center justify-center text-center text-[1.2rem] font-bold text-danger p-3 bg-bg-panel rounded-sm"
                            >
                                Cash part must be less than total
                            </div>
                        {:else}
                            <div
                                class="min-h-[64px] flex items-center justify-center text-center text-[1.5rem] font-bold text-warning p-3 bg-bg-panel rounded-sm invisible"
                            >
                                Change: £0.00
                            </div>
                        {/if}
                        <button
                            class="btn btn-success w-full p-3 md:p-5 text-lg md:text-[1.4rem] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                            disabled={paymentCompleteDisabled}
                            on:click={completeSale}
                        >
                            {isCompletingSale ? 'Saving Sale…' : 'Complete Sale'}
                        </button>
                    </div>
                </div>

                <div
                    class="w-full md:w-[340px] flex flex-col bg-bg-panel p-3 md:p-4 rounded-md"
                >
                    <div class="flex gap-3 mb-3">
                        <div class="np-display flex-1 !h-12 md:!h-[60px] !text-2xl md:!text-[2rem]">
                            {formatMoney(paymentInputAmount)}
                        </div>
                        <button
                            class="np-btn np-clear w-[50px] md:w-[60px] !h-12 md:!h-[60px]"
                            on:click={clearPaymentInput}>C</button
                        >
                    </div>
                    <div class="np-grid {paymentMethod === 'card' ? 'opacity-35 pointer-events-none' : ''}">
                        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"] as key}
                            <button
                                class="np-btn !h-10 md:!h-[60px] !text-lg md:!text-[1.5rem] {key === '⌫'
                                    ? '!text-warning'
                                    : ''}"
                                on:click={() => handlePaymentPadKey(key)}
                            >
                                {key}
                            </button>
                        {/each}
                    </div>
                    <div
                        class="grid grid-cols-3 gap-3 mt-3 {paymentMethod ===
                        'cash'
                            ? 'visible'
                            : 'invisible'}"
                    >
                        <button
                            class="flat-card flex flex-col items-center justify-center gap-1 p-3 cursor-pointer"
                            on:click={() => setAmountAndComplete(paymentDue)}
                        >
                            <div class="text-base font-bold">Pay Full</div>
                            <div class="text-xs text-text-muted">(Exact)</div>
                        </button>
                        {#if nextPoundAmount !== null}
                            <button
                                class="flat-card flex flex-col items-center justify-center gap-1 p-3 cursor-pointer !border-success"
                                on:click={() =>
                                    setAmountAndComplete(nextPoundAmount!)}
                            >
                                <div class="text-base font-bold text-success">
                                    {formatMoney(nextPoundAmount)}
                                </div>
                                <div class="text-[0.7rem] text-text-muted">
                                    Chg: {formatMoney(nextPoundAmount - paymentDue)}
                                </div>
                            </button>
                        {/if}
                        {#each fixedQuickAmounts as amt}
                            <button
                                class="flat-card flex flex-col items-center justify-center gap-1 p-3 cursor-pointer"
                                on:click={() => addQuickAmount(amt)}
                            >
                                <div class="text-base font-bold">
                                    + {formatMoney(amt)}
                                </div>
                            </button>
                        {/each}
                    </div>
                    <div class="mt-3 h-[52px] text-xs text-text-muted leading-snug {paymentMethod === 'card' ? '' : 'invisible'}">
                        {#if paymentInputAmount > 0 && paymentInputAmount < paymentDue}
                            <p>Cash part locked: {formatMoney(paymentInputAmount)}. Card will take {formatMoney(paymentDue - paymentInputAmount)}.</p>
                            <button class="mt-1 underline text-accent-primary font-bold" on:click={() => selectPaymentMethod("cash")}>Edit cash part</button>
                        {:else}
                            <p>Full card payment. For split payment, enter the cash amount on Cash first, then choose Card.</p>
                        {/if}
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
                    {@const lines = $orderLinesDB.filter(
                        (l) => l.orderId === ho.id,
                    )}
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
                {#if heldOrdersForTill.length === 0}<p
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
                                    {$registersDB.find((register) => register.id === ro.tillNumber)?.name || ro.tillNumber || "Unknown till"}
                                    · {$employeesDB.find((employee) => employee.id === ro.employeeId)?.name || "Unknown cashier"}
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
                    {#if recentOrders.length === 0}
                        <p class="text-center text-text-muted p-5">
                            No recent transactions
                        </p>
                    {/if}
                    {#if allRecentOrders.length > RECENT_TRANSACTIONS_PAGE_SIZE}
                        <div class="flex items-center justify-between gap-2 pt-2">
                            <button
                                class="btn btn-secondary"
                                disabled={recentTransactionsPage === 0}
                                on:click={() => {
                                    recentTransactionsPage--;
                                    selectedRecentOrderId = null;
                                }}>Newer</button
                            >
                            <span class="text-sm text-text-muted">
                                Page {recentTransactionsPage + 1} of {recentTransactionsPageCount}
                            </span>
                            <button
                                class="btn btn-secondary"
                                disabled={recentTransactionsPage >= recentTransactionsPageCount - 1}
                                on:click={() => {
                                    recentTransactionsPage++;
                                    selectedRecentOrderId = null;
                                }}>Older</button
                            >
                        </div>
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
                                        lines={$orderLinesDB
                                            .filter((line) => line.orderId === selectedRecentOrderId)
                                            .map((line) => ({
                                                ...line,
                                                sku: $productsDB.find((product) => product.id === line.productId)?.sku || '',
                                            }))}
                                        cashierName={$employeesDB.find((employee) => employee.id === selectedOrder.employeeId)?.name || ''}
                                        tillName={$registersDB.find((register) => register.id === selectedOrder.tillNumber)?.name || ''}
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
                            {#if canManage($currentEmployee) && selectedOrder.type !== "return" && ["completed", "partially_refunded"].includes(selectedOrder.status)}
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

            <button
                class="btn btn-success w-full h-16 text-xl"
                on:click={saveQuickProduct}
            >
                Save & Add to Cart
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
    .login-pin-layout { min-height: 0; display: grid; grid-template-columns: minmax(220px, .8fr) minmax(300px, 1fr); gap: 1rem; }
    .login-person { padding: 1.25rem; display: flex; flex-direction: column; gap: .35rem; border: 1px solid var(--border-flat); border-radius: .8rem; background: var(--bg-panel); }
    .login-person > span { color: var(--accent-primary); font-size: .68rem; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    .login-person > strong { font-size: 1.6rem; }
    .login-person > small, .login-person > p { color: var(--text-muted); }
    @media (max-width: 650px) { .login-pin-layout { grid-template-columns: 1fr; } .login-person p { display: none; } }
    .scale-workspace { width: min(1180px, 98vw); height: min(760px, 96vh); overflow: hidden; display: flex; flex-direction: column; border: 1px solid var(--border-flat); border-radius: 1rem; background: var(--bg-base); box-shadow: 0 24px 80px var(--shadow); }
    .scale-header { padding: .75rem 1rem; display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border-flat); background: color-mix(in srgb, var(--bg-card) 94%, transparent); }
    .scale-header h2 { margin: .1rem 0; font-size: 1.55rem; }
    .scale-header p { margin: 0; color: var(--text-muted); font-size: .85rem; }
    .scale-kicker { color: var(--success); font-size: .65rem; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    .scale-close { width: 2.5rem; height: 2.5rem; border-radius: .6rem; }
    .scale-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(300px, .75fr); }
    .scale-products { min-height: 0; padding: .75rem; display: flex; flex-direction: column; gap: .65rem; }
    .scale-page-tabs { display: flex; gap: .4rem; overflow-x: auto; min-height: 38px; padding-bottom: .1rem; }
    .scale-page-tabs button { min-height: 36px; padding: 0 .75rem; display: flex; align-items: center; gap: .4rem; white-space: nowrap; color: var(--text-main); font-size: .75rem; font-weight: 800; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-card); }
    .scale-page-tabs button i { width: .5rem; height: .5rem; border-radius: 50%; background: var(--scale-page-color); }
    .scale-page-tabs button.active { border-color: var(--scale-page-color); background: color-mix(in srgb, var(--scale-page-color) 14%, var(--bg-card)); }
    .scale-products .flat-input { padding-top: .65rem; padding-bottom: .65rem; }
    .scale-product-grid { min-height: 0; flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(3, minmax(0, 1fr)); gap: .55rem; }
    .scale-product { position: relative; min-height: 0; padding: .7rem; overflow: hidden; display: flex; flex-direction: column; align-items: flex-start; gap: .15rem; color: var(--text-main); text-align: left; border: 2px solid var(--border-flat); border-radius: .7rem; background: var(--bg-card); }
    .scale-product i { position: absolute; inset: 0 auto 0 0; width: 6px; background: var(--scale-color); }
    .scale-product strong { margin-top: auto; }
    .scale-product span, .scale-product small { color: var(--text-muted); font-size: .75rem; }
    .scale-product.selected { border-color: var(--success); background: color-mix(in srgb, var(--success) 10%, var(--bg-card)); }
    .scale-pagination { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: var(--text-muted); font-size: .72rem; }
    .scale-pagination div { display: flex; align-items: center; gap: .4rem; }
    .scale-pagination button { min-height: 34px; padding: 0 .65rem; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-card); color: var(--text-main); font-size: .72rem; font-weight: 800; }
    .scale-pagination button:disabled { opacity: .3; }
    .scale-entry { padding: .7rem; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: .45rem; border-left: 1px solid var(--border-flat); background: var(--bg-panel); }
    .scale-selected, .scale-display, .scale-total { padding: .6rem .7rem; display: flex; flex-direction: column; gap: .1rem; border: 1px solid var(--border-flat); border-radius: .6rem; background: var(--bg-card); }
    .scale-selected span, .scale-display span, .scale-total span { color: var(--text-muted); font-size: .7rem; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    .scale-selected small { color: var(--text-muted); }
    .scale-units { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; }
    .scale-units button, .scale-clear { padding: .48rem; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-card); color: var(--text-main); font-weight: 700; }
    .scale-units button.active { color: white; border-color: var(--success); background: var(--success); }
    .scale-display strong { font-size: 1.55rem; text-align: right; line-height: 1.1; }
    .scale-display small { font-size: .9rem; color: var(--text-muted); }
    .scale-numpad { flex: 1; min-height: 190px; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(4, minmax(0, 1fr)); gap: .35rem; }
    .scale-numpad button { min-height: 0; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-card); color: var(--text-main); font-size: 1.05rem; font-weight: 800; }
    .scale-total { margin-top: auto; flex-direction: row; align-items: center; justify-content: space-between; }
    .scale-total strong { color: var(--success); font-size: 1.45rem; }
    .scale-add { min-height: 46px; font-size: .95rem; }
    .scale-empty { padding: 2rem; color: var(--text-muted); text-align: center; border: 1px dashed var(--border-flat); border-radius: .8rem; }
    @media (max-width: 880px) { .scale-layout { grid-template-columns: 1fr 310px; } .scale-product-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-height: 690px) {
        .scale-workspace { height: 98vh; }
        .scale-header p, .scale-selected small { display: none; }
        .scale-header { padding: .45rem .8rem; }
        .scale-products, .scale-entry { padding: .5rem; gap: .3rem; }
        .scale-numpad { min-height: 150px; }
    }
</style>
