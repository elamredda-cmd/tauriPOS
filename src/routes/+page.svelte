<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte";
    import { get } from "svelte/store";
    import { goto } from "$app/navigation";
    import { isTauri } from "@tauri-apps/api/core";
    import { getCurrentWindow } from "@tauri-apps/api/window";
    import { ChevronRight, Delete as DeleteIcon, LockKeyhole, Maximize2, Minimize2, ScanLine, ShieldAlert, ShieldCheck, UsersRound, X } from "@lucide/svelte";
    import { playErrorSound, playItemAddedSound, playScanSuccessSound, playSuccessSound } from "$lib/sounds";
    import { randomTileColor } from "$lib/tileColors";
    import { planBanknotePayment } from '$lib/cashShortcuts';
    import { getDefaultProductCategoryId } from "$lib/categoryDefaults";
    import {
        productsDB,
        employeesDB,
        customersDB,
        taxRatesDB,
        activeCategories,
        activePosPages,
        activeProductById,
        activeProductIds,
        goodsProducts,
        productByBarcode,
        productById,
        scaleProductByPlu,
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
        weighableProductById,
        weighableProducts,
        type Customer,
        type CustomerAccount,
        type Discount,
        type Employee,
        type Order,
        type OrderLine,
        type Payment,
        type Product,
    } from "$lib/stores/db";
    import { toast, toasts, isBlockingToast, isScanDismissibleToast, dismissSaleCompletionOnScan } from "$lib/stores/toast";
    import { CheckoutScannerBuffer } from "$lib/checkoutScanner";
    import CheckoutCustomerForm from '$lib/components/CheckoutCustomerForm.svelte';
    import CartDiscountSummary from '$lib/components/CartDiscountSummary.svelte';
    import { newCheckoutCustomerDraft, registerCheckoutCustomer, type CheckoutCustomerDraft } from '$lib/checkoutCustomer';
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
        recordAuditEvent,
        getPosHeldOrders,
        getPosRecentReceipts,
        getLatestTillReceipt,
        getProductsByIds,
        getPaymentCustomer,
        getCustomerAccount,
        getOrderDetails,
        getOrderReversalContext,
        claimHeldOrder,
        prepareHeldOrderClaim,
        heldRecoverySaleCompleted,
        saveHeldOrderBundle,
        assertHeldOrderUploadComplete,
        saveCustomerProfile,
        isCustomerLoyaltyCodeInUse,
        flushOfflineQueue,
        POS_HELD_ORDERS_CHANGED_EVENT,
        type SaleBundle,
    } from "$lib/stores/database";
    import { evaluateCart, type CartEvaluation } from "$lib/utils/discountEngine";
    import { nextPromotionRefreshDelay, promotionEvaluationTime } from '$lib/promotionClock';
    import { loadHeldRecovery, persistHeldRecovery, type HeldRecovery } from '$lib/heldOrderRecovery';
    import { calculateCartTotals, calculateTaxLine } from "$lib/utils/commerceMath";
    import { SequentialQueue } from "$lib/utils/sequentialQueue";
    import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
    import ConnectionStatusPill from "$lib/components/ConnectionStatusPill.svelte";
    import AttendanceClock from "$lib/components/AttendanceClock.svelte";
    import CustomSelect from "$lib/components/CustomSelect.svelte";
    import Receipt from "$lib/components/Receipt.svelte";
    import { getReceiptDesign } from "$lib/receipt";
    import { authenticateEmployeePin, currentEmployee, currentShiftId, isEmployeeAuthorityCheckPending, logout, normalizeEmployeeForRuntime, PinRateLimitError, restoreRememberedEmployeeSession, startSupportSession, verifyEmployeePin } from "$lib/stores/session";
    import { connectionState } from "$lib/stores/connection";
    import { getBarcodeRules, parseScaleBarcode } from "$lib/barcodeRules";
    import { getScaleSaleDisplay } from "$lib/scaleSale";
    import { getLoyaltyConfig, loyaltyCredit, pointsForCredit, pointsForSpend } from "$lib/loyalty";
    import TouchDigitPad from "$lib/components/TouchDigitPad.svelte";
    import { modalFocusTrap } from "$lib/actions/modalFocusTrap";
    import SearchField from "$lib/components/SearchField.svelte";
    import SupportAccessPanel from "$lib/components/SupportAccessPanel.svelte";
    import type { SupportSessionGrant } from "$lib/supportAccess";
    import { broadcastCustomerDisplay, type CustomerDisplayPromotion, type CustomerDisplayState } from "$lib/customerDisplay";
    import { allocateRefundLines, allocateRefundPayment, getRemainingRefundAmount, refundCardInstructions } from "$lib/refunds";
    import { sendCctvAction, sendCctvItemAdded, sendCctvReceipt } from "$lib/cctvPos";
    import { cashDrawerTargetLabel, getCashDrawerConfig, openCashDrawer } from "$lib/cashDrawer";
    import { getLabelPrinterConfig, getReceiptPrinterConfig, printEscposReceipt, printProductLabels, sendEscposReceipt } from "$lib/printers";
    import { getLabelDesign } from "$lib/labels";
    import { formatScaleReading, getScaleHardwareConfig, readScaleWeight, type ScaleWeightReading } from "$lib/scaleHardware";
    import { requireManualSaleAccess } from "$lib/licensing";
    import { requiresAgeVerification } from "$lib/ageRestriction";
    import { canAccessPath, hasPermission, permissionForPath, permissionLabels, roleLabels, type PermissionKey } from "$lib/permissions";
    import { deviceOperatingMode, deviceOperatingModeLabel } from "$lib/deviceMode";
    import {
        acquireSumupLock,
        createSumupCheckout,
        delay,
        getSumupReaderStatus,
        getSumupTransactionByReference,
        getSumupTransactionStatus,
        loadSumupConfig,
        refreshSumupLock,
        releaseSumupLock,
        refundSumupTransaction,
        saveSumupAttempt,
        sumupConfig as sumupConfigStore,
        sumupTerminalKey,
        terminateSumupCheckout,
        updateSumupAttempt,
        type SumupConfig,
        type SumupPaymentAttempt,
        type SumupTransactionStatus,
    } from "$lib/sumup";
    import {
        acquireDojoLock,
        cancelDojoTerminalSession,
        createDojoPayment,
        dojoConfig as dojoConfigStore,
        dojoTerminalKey,
        getDojoPaymentIntentStatus,
        getDojoTerminalSessionStatus,
        loadDojoConfig,
        refreshDojoLock,
        refundDojoPaymentIntent,
        releaseDojoLock,
        respondToDojoSignature,
        saveDojoAttempt,
        updateDojoAttempt,
        type DojoConfig,
        type DojoPaymentAttempt,
        type DojoPaymentIntentStatus,
    } from "$lib/dojo";
    import { monitorDojoSession } from "$lib/dojoSessionFlow";
    import { retryDojoPayment } from '$lib/dojo';
    import DojoRetryDialog from '$lib/components/DojoRetryDialog.svelte';
    import DojoExpiryReview from '$lib/components/DojoExpiryReview.svelte';
    import { refreshPaymentTerminalAttempt } from '$lib/terminalAttempts';
    let dojoRetryDecision: ((retry: boolean) => void) | null = null;
    let showCheckoutExpiryReview = false;
    let checkoutExpiryAttempt: DojoPaymentAttempt | null = null;
    import { getDojoPaymentBreakdown } from "$lib/dojoPaymentValidation";
    import { cashbackRecoveryMessage } from "$lib/paymentExtraPresentation";
    import {
        assertPaymentTerminalAttemptReady,
        requirePreparedSaleBundle,
    } from "$lib/terminalAttempts";
    import { runTerminalRecovery } from "$lib/terminalRecovery";

    type PosOrderSummary = Order & {
        cashierName?: string;
        tillName?: string;
        customerName?: string;
    };

    type AddToCartProduct = {
        id: string;
        name: string;
        price: number;
        isAgeRestricted?: boolean;
        forceSeparateLine?: boolean;
        isPriceOverride?: boolean;
        originalPrice?: number;
        sourceBarcode?: string;
        quantityLocked?: boolean;
        skipStockAdjustment?: boolean;
        note?: string;
    };

    type PendingAgeRestrictedAdd = {
        product: AddToCartProduct;
        feedback: "item" | "scan";
        onAdded?: () => void;
    };

    let activePageId = "";
    let currentPageIndex = 0;
    let searchQuery = "";
    let scanInput: HTMLInputElement;
    let scannerFocusTimer: ReturnType<typeof setTimeout> | undefined;
    const scannerBuffer = new CheckoutScannerBuffer();
    let scannerBufferTimer: ReturnType<typeof setTimeout> | undefined;
    let scanFlowWaiters: Array<() => void> = [];
    let posDestroyed = false;
    const scanQueue = new SequentialQueue<string>(performProductSearch, waitForScannerReady);
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
    let activeHeldRecovery: HeldRecovery | null = null;
    let pendingHeldRecovery: HeldRecovery | null = null;
    let heldRecoveryWriteError = '';
    $: if (activeHeldRecovery) persistRecoveredTrolley(cart, selectedCustomerId, selectedManualDiscountId);

    async function persistRecoveredTrolley(lines: typeof cart, customerId: string, discountId: string) {
        if (!activeHeldRecovery) return;
        try {
            if (!lines.length) {
                activeHeldRecovery = null;
                pendingHeldRecovery = null;
                await persistHeldRecovery(null);
            } else {
                const draft = { ...activeHeldRecovery, cart: lines, customerId, discountId };
                await persistHeldRecovery(draft);
            }
            heldRecoveryWriteError = '';
        } catch {
            heldRecoveryWriteError = 'Trolley recovery could not be saved. Free some storage before taking payment.';
        }
    }
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
    let heldOrderView: "this" | "other" = "this";
    let showPaymentModal = false;
    let showDiscountModal = false;
    let showAppliedDiscounts = false;
    let pendingAgeRestrictedAdd: PendingAgeRestrictedAdd | null = null;
    let ageRestrictedConfirmButton: HTMLButtonElement;
    let selectedManualDiscountId = "";
    let paymentMethod: "cash" | "card" | "account" = "cash";
    let amountTenderedString = "0";
    let hasTypedPayment = false;
    let terminalPaymentStage: "idle" | "reserving" | "sending" | "waiting" | "cancelling" | "approved" | "saving" = "idle";
    let terminalPaymentMessage = "";
    let terminalCancelRequested = false;
    let activeDojoSessionId = "";
    let showDojoSignatureConfirm = false;
    let dojoSignatureDecision: ((accepted: boolean) => void) | null = null;
    let recoveringSumupPayments = false;
    let recoveringDojoPayments = false;
    let cartItemEls: HTMLElement[] = [];
    let cartScrollFrame: number | undefined;
    let lastCartScrollIndex = -1;
    let customerSearch = "";
    let paymentCustomerSearchOpen = false;
    let paymentCustomerToggle: HTMLButtonElement;
    let showNewPaymentCustomer = false;
    let newPaymentCustomer: CheckoutCustomerDraft | null = null;
    let newPaymentCustomerSaving = false;
    let newPaymentCustomerError = '';
    let newPaymentCustomerAuthorized = false;
    let selectedCustomerId = "";
    let selectedCustomerAccount: CustomerAccount | null = null;
    let customerAccountBusy = false;
    let customerAccountLoadError = false;
    let customerAccountLoadToken = 0;
    let useLoyaltyCredit = false;
    let loyaltyCreditBusy = false;
    let customerSearchInput: HTMLInputElement;
    $: loyaltyConfig = getLoyaltyConfig($settingsDB);
    $: selectedCustomer = $customersDB.find((customer) => customer.id === selectedCustomerId) || null;
    $: availableLoyaltyCredit = selectedCustomer && loyaltyConfig.enabled ? loyaltyCredit(selectedCustomer.loyaltyPoints, loyaltyConfig) : 0;
    $: loyaltyRedemptionAvailable = $connectionState.mode !== "multi" || $connectionState.mysqlOnline;
    $: loyaltyCreditUsed = useLoyaltyCredit ? Math.min(total, availableLoyaltyCredit) : 0;
    $: loyaltyPointsRedeemed = pointsForCredit(loyaltyCreditUsed, loyaltyConfig);
    $: paymentDue = Math.max(0, total - loyaltyCreditUsed);
    $: accountBalanceAfterSale = (selectedCustomerAccount?.balancePence || 0) + paymentDue;
    $: accountLimitAllowsSale = !selectedCustomerAccount
        || selectedCustomerAccount.creditLimitPence <= 0
        || accountBalanceAfterSale <= selectedCustomerAccount.creditLimitPence;
    $: accountSaleAvailable = Boolean(
        selectedCustomer
        && selectedCustomerAccount?.isEnabled
        && paymentDue > 0
        && accountLimitAllowsSale
        && ($connectionState.mode !== "multi" || $connectionState.mysqlOnline)
        && hasPermission($currentEmployee, "charge_customer_account", $settingsDB)
    );
    $: loyaltyPointsEarned = selectedCustomer && loyaltyConfig.enabled ? pointsForSpend(paymentDue, loyaltyConfig) : 0;
    $: paymentInputAmount = parseInt(amountTenderedString) || 0;
    $: cardCashPartInvalid = paymentMethod === "card" && paymentInputAmount > 0 && paymentInputAmount >= paymentDue;
    $: activeManagedProvider = $dojoConfigStore.enabled && $dojoConfigStore.ready
        ? "dojo" as const
        : $sumupConfigStore.enabled && $sumupConfigStore.ready
            ? "sumup" as const
            : null;
    $: managedCardEnabled = activeManagedProvider !== null;
    $: managedProviderName = activeManagedProvider === "dojo" ? "Dojo" : activeManagedProvider === "sumup" ? "SumUp" : "Card";
    $: managedTerminalName = activeManagedProvider === "dojo"
        ? ($dojoConfigStore.terminalName || "Dojo terminal")
        : activeManagedProvider === "sumup"
            ? ($sumupConfigStore.readerName || "SumUp Solo")
            : "Card terminal";
    $: paymentCompleteDisabled =
        cashShortcutBusy || loyaltyCreditBusy ||
        showNewPaymentCustomer || newPaymentCustomerSaving ||
        isCompletingSale ||
        (paymentMethod === "cash" && paymentInputAmount < paymentDue) ||
        cardCashPartInvalid ||
        (paymentMethod === "card" && managedCardEnabled && ($connectionState.mode !== "multi" || !$connectionState.mysqlOnline)) ||
        (paymentMethod === "account" && (!accountSaleAvailable || customerAccountBusy));
    $: customerMatches = customerSearch.trim()
        ? $customersDB.filter((customer) => {
            const query = customerSearch.trim().toLowerCase();
            return [customer.name, customer.loyaltyCode, customer.phone, customer.postcode]
                .some((value) => String(value || "").toLowerCase().includes(query));
        }).slice(0, 5)
        : [];

    let showNotFoundModal = false;
    let notFoundBarcode = "";
    let scanAgainButton: HTMLButtonElement;
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
    const SCALE_PRODUCTS_PER_PAGE = 9;
    const POS_TILES_PER_PAGE = 16;
    const MAX_SCALE_WEIGHT_DIGITS = 6;
    const MAX_ORDER_TOTAL_PENCE = 999_999_999;
    let quickAddName = "";
    let quickAddSku = "";
    let quickAddPrice = "0";
    let quickAddCategoryId = "";
    let quickAddTaxRateId = "";
    let quickAddAgeRestricted = false;
    let quickAddAuthorized = false;
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
    let loginErrorPin = "";
    let loginBusy = false;
    let loginFullscreen = false;
    let loginFullscreenBusy = false;
    let showSupportAccess = false;
    let loginDialog: HTMLElement;
    let loginPinInput: HTMLInputElement | null = null;
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
    let openingShiftBusy = false;
    let rememberedSessionChecked = false;
    let restoringRememberedSession = false;
    $: activeLoginEmployees = $employeesDB
        .map(normalizeEmployeeForRuntime)
        .filter((employee): employee is Employee => Boolean(employee?.isActive))
        .filter((employee) => $deviceOperatingMode !== 'back_office'
            || employee.role === 'attendance'
            || canAccessPath(employee, '/admin', $settingsDB))
        .sort((a, b) => a.name.localeCompare(b.name));
    $: selectedLoginEmployee = activeLoginEmployees.find((employee) => employee.id === selectedLoginEmployeeId) || null;
    $: if (loginError && loginPin && loginPin !== loginErrorPin) loginError = "";
    $: if (!$currentEmployee && loginDialog) void tick().then(() => loginDialog?.focus({ preventScroll: true }));
    $: if (showNotFoundModal && scanAgainButton) {
        void tick().then(() => {
            if (showNotFoundModal && scanAgainButton?.isConnected) {
                scanAgainButton.focus({ preventScroll: true });
            }
        });
    }
    $: if (pendingAgeRestrictedAdd && ageRestrictedConfirmButton) {
        void tick().then(() => {
            if (pendingAgeRestrictedAdd && ageRestrictedConfirmButton?.isConnected) {
                ageRestrictedConfirmButton.focus({ preventScroll: true });
            }
        });
    }
    $: managerApprovers = $employeesDB
        .filter((employee) => employee.isActive && hasPermission(employee, managerApprovalPermission, $settingsDB))
        .sort((a, b) => a.name.localeCompare(b.name));
    $: if (showManagerApprovalModal && (!managerApprovalEmployeeId || !managerApprovers.some((employee) => employee.id === managerApprovalEmployeeId))) {
        managerApprovalEmployeeId = managerApprovers[0]?.id || "";
    }
    $: if (
        !rememberedSessionChecked
        && !$currentEmployee
        && $employeesDB.length > 0
        && !isEmployeeAuthorityCheckPending($connectionState)
    ) {
        rememberedSessionChecked = true;
        void restoreLastEmployeeSession();
    }
    $: cashDrawerConfig = getCashDrawerConfig($settingsDB);
    $: receiptPrinterConfig = getReceiptPrinterConfig($settingsDB);
    $: scaleHardwareConfig = getScaleHardwareConfig($settingsDB);
    $: cashDrawerTarget = cashDrawerTargetLabel(cashDrawerConfig);

    let goodsSearchQuery = "";
    $: filteredGoods = $goodsProducts
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
    $: allWeighableProducts = $weighableProducts;
    $: configuredScaleProducts = activeScaleTilePage?.productIds.length
        ? activeScaleTilePage.productIds.map((id) => $weighableProductById.get(id)).filter(Boolean)
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

    function scannerFocusBlocked(allowCompletedSaleScan = false): boolean {
        if (typeof document === "undefined") return true;
        return !$currentEmployee ||
            attendanceClockOpen ||
            $toasts.some(item => isBlockingToast(item) && !(allowCompletedSaleScan && isScanDismissibleToast(item))) ||
            showNumpad ||
            showChangePricePad ||
            showGoodsModal ||
            showHeldOrders ||
            showPaymentModal ||
            showCheckoutExpiryReview ||
            showDiscountModal ||
            showAppliedDiscounts ||
            showNotFoundModal ||
            showQuickAddModal ||
            showScaleModal ||
            showClearConfirm ||
            showReversalConfirm ||
            Boolean(pendingAgeRestrictedAdd) ||
            showManagerApprovalModal ||
            showPartialRefundPad ||
            showRecentTransactions ||
            isHoldingOrder ||
            isCompletingSale ||
            Boolean(document.querySelector(".touch-input-backdrop"));
    }

    function releaseScanFlowWaiters() {
        if (scannerFocusBlocked()) return;
        const waiters = scanFlowWaiters.splice(0);
        for (const resolve of waiters) resolve();
    }

    function waitForScannerReady(): Promise<void> {
        if (!scannerFocusBlocked() || posDestroyed) return Promise.resolve();
        return new Promise((resolve) => scanFlowWaiters.push(resolve));
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
        scannerBuffer.clear();
        if (scannerBufferTimer) clearTimeout(scannerBufferTimer);
        scannerBufferTimer = undefined;
    }

    function handleGlobalScannerKeydown(event: KeyboardEvent) {
        // A completed-sale prompt is the only overlay a new scan can dismiss.
        // Buffer the entire code before removing it so the first character is
        // not lost while the dialog restores focus to the checkout input.
        if (scannerFocusBlocked(true) || event.defaultPrevented || event.metaKey ||
            event.ctrlKey || event.altKey || event.isComposing || event.repeat) {
            clearScannerBuffer();
            return;
        }

        const active = document.activeElement as HTMLElement | null;
        if (!scannerBuffer.pending) {
            if (active === scanInput && !$toasts.some(isScanDismissibleToast)) return;
            if (active !== scanInput && active?.closest("input, textarea, select, [contenteditable='true']")) return;
        }

        const result = scannerBuffer.push(event.key, Date.now());
        if (result.barcode) {
            clearScannerBuffer();
            event.preventDefault();
            event.stopImmediatePropagation();
            dismissSaleCompletionOnScan();
            searchQuery = result.barcode;
            void handleSearch().finally(() => focusScannerSoon(true));
            return;
        }

        if (!result.captured) return;
        // Retain ownership through focus changes and consume Enter exactly once.
        event.preventDefault();
        event.stopImmediatePropagation();
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
            isAgeRestricted: asBoolean(product.isAgeRestricted),
            isWeighable: asBoolean(product.isWeighable),
            showInGoods: asBoolean(product.showInGoods),
            isActive: asBoolean(product.isActive, true),
        } as Product;
    }

    function rememberProductInPosCache(product: any) {
        if (!product?.id) return;
        const normalized = normalizeProductForCache(product);
        const items = get(productsDB);
        const index = items.findIndex((item) => item.id === normalized.id);
        if (index === -1) {
            productsDB.set([...items, normalized]);
            return;
        }

        const current = items[index];
        const changed = Object.entries(normalized).some(([key, value]) =>
            (current as any)[key] !== value
        );
        if (!changed) return;

        const next = items.slice();
        next[index] = { ...current, ...normalized };
        productsDB.set(next);
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
            product: $activeProductById.get(tile.productId),
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
        $activeProductIds.has(membership.productId),
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
            promotionEvaluationTime(promoClock),
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
        const product = $productById.get(item.id);
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
        lines: cart.map((item, index) => {
            const lineEvaluation = cartEval.lines[index];
            return {
                name: item.name,
                quantity: item.quantity,
                unitPrice: item.price,
                total: item.price * item.quantity,
                discount: lineEvaluation?.savings || 0,
                promotion: getCustomerDisplayPromotion(lineEvaluation),
            };
        }),
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
        return { ...evaluation, lines, totalSavings: lines.reduce((sum, line) => sum + line.savings, 0) };
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

    function getCustomerDisplayPromotion(
        line: CartEvaluation["lines"][number] | undefined,
    ): CustomerDisplayPromotion | undefined {
        if (!line) return undefined;
        const promotions = line.applied.length > 0 ? line.applied : line.eligibleFor;
        if (promotions.length === 0) return undefined;

        const status = line.applied.length > 0 ? "applied" : "eligible";
        const discountKinds = new Set(
            promotions
                .map((promotion) => $discountsDB.find((discount) => discount.id === promotion.discountId)?.kind)
                .filter(Boolean),
        );
        const onlyKind = discountKinds.size === 1 ? [...discountKinds][0] : "";
        const label = onlyKind === "bundle_fixed_price"
            ? "Bundle"
            : onlyKind === "bogo_fixed_price"
                ? "BOGO"
                : onlyKind?.startsWith("manual_")
                    ? "Discount"
                    : "Promotion";
        const name = promoNameSummary(promotions.map((promotion) => promotion.discountName));

        if (status === "eligible") {
            return { status, label, text: `${name} · ${eligiblePromotionDetail(line)}` };
        }

        const saving = line.applied.reduce((sum, promotion) => sum + promotion.savings, 0);
        const dealText = line.applied
            .map((promotion) => discountDealText($discountsDB.find((discount) => discount.id === promotion.discountId)))
            .filter(Boolean);
        const deal = dealText.length === 0
            ? ""
            : dealText.length === 1
                ? dealText[0]
                : `${dealText[0]} +${dealText.length - 1}`;
        const savingText = `${formatMoney(saving)} saved`;
        return {
            status,
            label,
            text: `${name} · ${deal ? `${deal} · ` : ""}${savingText}`,
        };
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
            managerApprovalError = "Choose an authorized approver";
            return;
        }
        let approver: Employee | null;
        try {
            approver = await verifyEmployeePin(managerApprovalEmployeeId, managerApprovalPin);
        } catch (error) {
            managerApprovalError = error instanceof PinRateLimitError
                ? error.message
                : "Could not verify this PIN";
            managerApprovalPin = "";
            return;
        }
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

    async function selectManualDiscount(id: string) {
        const previousSavings = promoSavings;
        const previousDiscount = $discountsDB.find((discount) => discount.id === selectedManualDiscountId);
        selectedManualDiscountId = id;
        showDiscountModal = false;
        await tick();
        const selectedDiscount = $discountsDB.find((discount) => discount.id === id);
        sendCctvAction({
            action: id ? "DISCOUNT" : "DISCOUNT REMOVED",
            name: selectedDiscount?.name || previousDiscount?.name || "Manual discount",
            amount: id ? promoSavings : previousSavings,
        });
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
    let promotionTimer: ReturnType<typeof setTimeout> | null = null;
    let promotionClockMounted = false;
    let refreshingSaleQuote = false;

    function refreshPromotionClock() {
        if (!isCompletingSale) promoClock = new Date().toISOString();
    }

    function schedulePromotionRefresh(windows: Parameters<typeof nextPromotionRefreshDelay>[0], _clock: string, paused: boolean) {
        if (promotionTimer) clearTimeout(promotionTimer);
        promotionTimer = null;
        if (!promotionClockMounted || paused) return;
        promotionTimer = setTimeout(refreshPromotionClock, nextPromotionRefreshDelay(windows, Date.now()));
    }

    $: if (promotionClockMounted) schedulePromotionRefresh([...$discountsDB, ...$promoGroupsDB], promoClock, isCompletingSale);
    $: attendanceEnabled = ($settingsDB.find(s => s.key === 'time_attendance_enabled')?.value ?? 'false') === 'true';
    $: if (!attendanceEnabled) attendanceClockOpen = false;
    let attendanceClockOpen = false;
    $: headerTime = new Date(promoClock).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    }).toUpperCase();

    onMount(() => {
        promotionClockMounted = true;
        refreshPromotionClock();
        window.addEventListener('focus', refreshPromotionClock);
        document.addEventListener('visibilitychange', refreshPromotionClock);

        const handleFullscreenChange = () => {
            if (!isTauri()) loginFullscreen = Boolean(document.fullscreenElement);
        };
        void refreshLoginFullscreenState();

        // Checkout hardware, receipt allocation and scanner listeners must not
        // start on a computer configured only for Back Office work.
        const checkoutDevice = $deviceOperatingMode !== 'back_office';
        if (checkoutDevice) {
            void loadHeldRecovery().then(draft => { if (!posDestroyed) pendingHeldRecovery = draft; })
                .catch(error => toast(String(error), 'error'));
        }
        if (isTauri() && checkoutDevice) {
            void Promise.allSettled([loadSumupConfig(), loadDojoConfig()])
                .then(() => Promise.allSettled([recoverApprovedSumupSales(), recoverApprovedDojoSales()]))
                .catch((error) => console.warn("Could not initialize card terminals:", error));
            getOrCreateTillId().then(async id => {
                tillId = id;
                await ensureTillReceiptSequence();
                tillName = await getTillName();
            });
        } else if (checkoutDevice) {
            tillId = "browser-preview-till";
            tillName = "Browser Preview";
            if (!get(currentShiftId)) currentShiftId.set("browser-preview-shift");
        } else {
            tillName = 'Back Office';
            currentShiftId.set('');
        }
        if (checkoutDevice) {
            document.addEventListener("pointerup", handlePosPointerUp);
            document.addEventListener("keydown", handleGlobalScannerKeydown, true);
            focusScannerSoon();
        }
        document.addEventListener("fullscreenchange", handleFullscreenChange);
        const handleHeldOrdersChanged = () => void refreshHeldOrderSummaries();
        window.addEventListener(POS_HELD_ORDERS_CHANGED_EVENT, handleHeldOrdersChanged);

        return () => {
            promotionClockMounted = false;
            if (promotionTimer) clearTimeout(promotionTimer);
            window.removeEventListener('focus', refreshPromotionClock);
            document.removeEventListener('visibilitychange', refreshPromotionClock);
            if (scannerFocusTimer) clearTimeout(scannerFocusTimer);
            clearScannerBuffer();
            document.removeEventListener("pointerup", handlePosPointerUp);
            document.removeEventListener("keydown", handleGlobalScannerKeydown, true);
            document.removeEventListener("fullscreenchange", handleFullscreenChange);
            window.removeEventListener(POS_HELD_ORDERS_CHANGED_EVENT, handleHeldOrdersChanged);
        };
    });

    onDestroy(() => {
        posDestroyed = true;
        dismissDojoSignatureDecision();
        if (trolleyMessageTimeout) clearTimeout(trolleyMessageTimeout);
        for (const resolve of scanFlowWaiters.splice(0)) resolve();
        scanQueue.destroy();
        if (cartScrollFrame) cancelAnimationFrame(cartScrollFrame);
        if (terminalPaymentStage !== "idle") {
            terminalCancelRequested = true;
            if (activeDojoSessionId) void cancelDojoTerminalSession(activeDojoSessionId).catch(() => undefined);
            else void terminateSumupCheckout().catch(() => undefined);
        }
    });

    let tillId = '';
    let tillName = 'Till 1';

    async function refreshLoginFullscreenState() {
        try {
            loginFullscreen = isTauri()
                ? await getCurrentWindow().isFullscreen()
                : Boolean(document.fullscreenElement);
        } catch {
            loginFullscreen = Boolean(document.fullscreenElement);
        }
    }

    async function toggleLoginFullscreen() {
        if (loginFullscreenBusy) return;
        loginFullscreenBusy = true;
        try {
            if (isTauri()) {
                const appWindow = getCurrentWindow();
                const next = !(await appWindow.isFullscreen());
                await appWindow.setFullscreen(next);
                loginFullscreen = next;
            } else if (document.fullscreenElement) {
                await document.exitFullscreen();
                await refreshLoginFullscreenState();
            } else {
                await document.documentElement.requestFullscreen();
                await refreshLoginFullscreenState();
            }
        } catch (error) {
            console.error("Could not change fullscreen mode:", error);
            toast("Could not change full screen mode", "error");
        } finally {
            loginFullscreenBusy = false;
        }
    }

    async function login() {
        if (loginBusy) return;
        if (!selectedLoginEmployeeId) {
            loginError = "Choose your user first";
            return;
        }
        if (!/^\d{4,8}$/.test(loginPin)) {
            loginErrorPin = loginPin;
            loginError = "Enter a 4 to 8 digit PIN";
            return;
        }
        loginBusy = true;
        try {
            const employee = await authenticateEmployeePin(selectedLoginEmployeeId, loginPin);
            if (!employee) {
                loginErrorPin = loginPin;
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
            loginErrorPin = loginPin;
            loginPin = "";
            const message = error instanceof Error ? error.message : '';
            loginError = error instanceof PinRateLimitError
                ? error.message
                : message.includes('Back Office access') || message.includes('MariaDB is still preparing staff access')
                    ? message
                    : "Could not open this till shift. Check the database connection and try again.";
        } finally {
            loginBusy = false;
        }
    }

    async function prepareEmployeeSession(employee: Employee) {
        const normalizedEmployee = normalizeEmployeeForRuntime(employee);
        if (!normalizedEmployee?.isActive) {
            throw new Error('This staff account has an invalid or inactive role');
        }
        employee = normalizedEmployee;
        if (employee.role === 'attendance') {
            currentShiftId.set('');
            return;
        }
        if ($deviceOperatingMode === 'back_office') {
            if (!canAccessPath(employee, '/admin', $settingsDB)) {
                throw new Error('This staff account does not have Back Office access.');
            }
            currentShiftId.set('');
            await goto('/admin', { replaceState: true });
            return;
        }
        if (!isTauri()) {
            currentShiftId.set(get(currentShiftId) || "browser-preview-shift");
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
            openingShiftBusy = false;
            loginPin = "";
            loginError = "";
            return;
        }
        currentShiftId.set(existingShiftId || await ensureOpenShift(employee.id, registerId));
    }

    async function restoreLastEmployeeSession() {
        restoringRememberedSession = true;
        try {
            const employee = await restoreRememberedEmployeeSession();
            if (!employee) return;
            await prepareEmployeeSession(employee);
            selectedLoginEmployeeId = "";
            loginPin = "";
            loginError = "";
        } catch (error) {
            console.error("Could not restore previous staff session:", error);
            logout();
            const message = error instanceof Error ? error.message : '';
            loginError = message.includes('Back Office access')
                ? message
                : "Could not reopen the previous staff session. Sign in again.";
        } finally {
            restoringRememberedSession = false;
        }
    }

    async function openShiftWithFloat() {
        const employee = pendingShiftEmployee;
        if (!employee || openingShiftBusy) return;
        const openingFloat = Math.max(0, parseInt(openingFloatString) || 0);
        openingShiftBusy = true;
        try {
            const registerId = tillId || await getOrCreateTillId();
            tillId = registerId;
            currentShiftId.set(await ensureOpenShift(
                employee.id,
                registerId,
                openingFloat,
            ));
            if (pendingShiftEmployee?.id === employee.id) pendingShiftEmployee = null;
            openingFloatString = "0";
            toast("Till shift opened", "success");
        } catch (error) {
            console.error("Could not open till shift:", error);
            toast("Could not open the till shift. Check the database connection and try again.", "error");
        } finally {
            openingShiftBusy = false;
        }
    }

    function cancelOpeningShift() {
        if (openingShiftBusy) return;
        pendingShiftEmployee = null;
        openingFloatString = "0";
        logout();
    }

    function chooseLoginEmployee(employeeId: string) {
        if (loginBusy) return;
        selectedLoginEmployeeId = employeeId;
        loginPin = "";
        loginError = "";
        loginErrorPin = "";
        void tick().then(() => {
            if ($deviceOperatingMode === 'back_office' && employeeId) {
                loginPinInput?.focus({ preventScroll: true });
                return;
            }
            loginDialog?.focus({ preventScroll: true });
        });
    }

    function openSupportAccess() {
        if (loginBusy) return;
        chooseLoginEmployee("");
        showSupportAccess = true;
    }

    function dismissLoginDialog() {
        if (loginBusy) return;
        if (showSupportAccess) {
            showSupportAccess = false;
            return;
        }
        if (selectedLoginEmployee) chooseLoginEmployee("");
    }

    async function activateSupportSession(grant: SupportSessionGrant) {
        startSupportSession(grant);
        showSupportAccess = false;
        const expiry = new Date(grant.expiresAt).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
        }).toUpperCase();
        toast(`L&Bj Support access active until ${expiry}`, "success");
        await goto("/admin");
    }

    function employeeInitials(name: string) {
        const parts = String(name || "Staff").trim().split(/\s+/).filter(Boolean);
        return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0] || ""}` : parts[0]?.slice(0, 2) || "ST").toUpperCase();
    }

    function handleLoginKeydown(event: KeyboardEvent): boolean {
        if ($currentEmployee || !selectedLoginEmployee || pendingShiftEmployee || loginBusy) return false;
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
        if (
            $deviceOperatingMode === 'back_office'
            && (event.target as HTMLElement | null)?.matches('.login-desktop-pin-input')
        ) return false;

        if (/^\d$/.test(event.key)) {
            event.preventDefault();
            if (loginPin.length < 8) loginPin += event.key;
            return true;
        }
        if (event.key === "Backspace") {
            event.preventDefault();
            loginPin = loginPin.slice(0, -1);
            return true;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            chooseLoginEmployee("");
            return true;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            void login();
            return true;
        }
        return false;
    }

    function handleDesktopLoginPinInput(event: Event & { currentTarget: HTMLInputElement }) {
        const sanitized = event.currentTarget.value.replace(/\D/g, '').slice(0, 8);
        event.currentTarget.value = sanitized;
        loginPin = sanitized;
        if (loginError) loginError = '';
    }

    function handleDesktopLoginPinKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            chooseLoginEmployee('');
        }
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

    function sendCctvCartProductName(item: { name: string; price: number; quantity?: number } | undefined) {
        if (!item) return;
        sendCctvItemAdded({
            name: item.name,
            price: item.price,
            quantity: item.quantity || 1,
            tillName,
            cashierName: $currentEmployee?.name || "",
        });
    }

    function sendCctvCartAction(
        action: string,
        item: { name: string; price: number; quantity?: number } | undefined,
    ) {
        if (!item) return;
        const quantity = item.quantity || 1;
        sendCctvAction({
            action,
            name: item.name,
            quantity,
            amount: item.price * quantity,
        });
    }

    function sendCompletedBundleToCctv(bundle: SaleBundle, reversalAction = "") {
        if (bundle.order.type === "return" || reversalAction) {
            sendCctvAction({
                action: reversalAction || (String(bundle.order.notes || "").toUpperCase().startsWith("VOID") ? "VOID" : "REFUND"),
                name: bundle.order.notes || `Receipt ${bundle.order.orderNumber || ""}`.trim(),
                amount: Math.abs(Number(bundle.order.total || 0)),
            }, "receipt");
            return;
        }
        sendCctvReceipt({
            storeName: $storeDB.name,
            tillName,
            cashierName: $currentEmployee?.name || "",
            paymentMethod: bundle.order.paymentMethod || bundle.payment.method || "",
            subtotal: Math.max(0, Number(bundle.order.subtotal || 0)),
            discount: Math.max(0, Number(bundle.order.discountAmount || 0)),
            total: Math.max(0, Number(bundle.order.total || 0)),
            lines: bundle.lines.map((line) => ({
                name: line.productName,
                quantity: Math.abs(Number(line.quantity || 0)),
                unitPrice: Math.abs(Number(line.unitPrice || 0)),
                lineTotal: Math.abs(Number(line.lineTotal || 0)),
                discount: Math.abs(Number(line.discountAmount || 0)),
            })),
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
        } else if (key === "DEL" || key === "⌫") {
            numpadValue = numpadValue.slice(0, -1);
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
        sendCctvCartAction("REMOVE", cart[selectedCartIndex]);
        cart.splice(selectedCartIndex, 1);
        cart = [...cart];
        if (selectedCartIndex >= cart.length)
            selectedCartIndex = Math.max(0, cart.length - 1);
        if (cart.length === 0) clearTrolleyCustomer();
    }

    function deleteItem(index: number) {
        if (!cart[index]) return;
        sendCctvCartAction("REMOVE", cart[index]);
        cart.splice(index, 1);
        if (selectedCartIndex > index) selectedCartIndex--;
        cart = [...cart];
        if (selectedCartIndex >= cart.length)
            selectedCartIndex = Math.max(0, cart.length - 1);
        if (cart.length === 0) clearTrolleyCustomer();
    }

    function commitAddToCart(product: AddToCartProduct, feedback: "item" | "scan" = "item"): boolean {
        const existing = product.forceSeparateLine ? -1 : cart.findIndex((i) => i.id === product.id);
        if (existing >= 0) {
            if (cart[existing].quantity >= MAX_CART_QUANTITY) {
                toast(`Quantity cannot be more than ${MAX_CART_QUANTITY.toLocaleString()}`, "error");
                return false;
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
        if (feedback === "scan") playScanSuccessSound();
        else playItemAddedSound();
        sendCctvCartProductName(cart[selectedCartIndex]);
        return true;
    }

    function addToCart(
        product: AddToCartProduct,
        feedback: "item" | "scan" = "item",
        onAdded?: () => void,
    ): boolean {
        const catalogProduct = $productById.get(product.id) || product;
        if (requiresAgeVerification(catalogProduct, $settingsDB)) {
            pendingAgeRestrictedAdd = { product, feedback, onAdded };
            playErrorSound();
            return false;
        }
        const added = commitAddToCart(product, feedback);
        if (added) onAdded?.();
        return added;
    }

    function confirmAgeRestrictedAdd() {
        const pending = pendingAgeRestrictedAdd;
        pendingAgeRestrictedAdd = null;
        if (!pending) return;
        const added = commitAddToCart(pending.product, pending.feedback);
        if (added) pending.onAdded?.();
    }

    function cancelAgeRestrictedAdd() {
        pendingAgeRestrictedAdd = null;
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
        scaleReadStatus = `Scale reading: ${formatScaleReading(reading)}`;
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

    function closeScaleModal() {
        showScaleModal = false;
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
        }, "item", () => {
            closeScaleModal();
            toast(`${selectedScaleProduct.name} added from scale`, "success");
        });
    }

    async function performProductSearch(query: string) {
        try {
            const cachedProduct = $productByBarcode.get(normalizeLookupCode(query));
            const found = cachedProduct || await searchProduct(query);

            if (found) {
                const product = normalizeProductForCache(found);
                if (!cachedProduct) rememberProductInPosCache(product);
                if (product.isWeighable) {
                    openScaleForProduct(product.id);
                    return;
                }
                addToCart({
                    id: product.id,
                    name: product.name,
                    price: product.price,
                }, "scan");
                return;
            }
            const parsed = parseScaleBarcode(query, getBarcodeRules($settingsDB));
            if (parsed) {
                const cachedScaleProduct = $scaleProductByPlu.get(normalizeLookupCode(parsed.scalePlu));
                const scaleProduct = cachedScaleProduct || await searchProductByScalePlu(parsed.scalePlu);
                if (!scaleProduct) {
                    toast(`No active product has Scale PLU ${parsed.scalePlu}`, "error");
                    playErrorSound();
                    return;
                }
                const product = normalizeProductForCache(scaleProduct);
                if (!cachedScaleProduct) rememberProductInPosCache(product);
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
                    }, "scan");
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
                }, "scan");
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

    function handleSearch(): Promise<void> {
        const query = searchQuery.trim();
        searchQuery = "";
        if (!query || scannerFocusBlocked()) return Promise.resolve();

        return scanQueue.enqueue(query);
    }

    function dismissNotFoundModal() {
        showNotFoundModal = false;
        searchQuery = "";
        notFoundBarcode = "";
        focusScannerSoon(true);
    }

    function showAuthorizedQuickAdd() {
        showNotFoundModal = false;
        quickAddName = "";
        quickAddSku = "";
        quickAddPrice = "0";
        quickAddAgeRestricted = false;
        quickAddAuthorized = true;
        quickAddBusy = false;
        quickAddCategoryId = getDefaultProductCategoryId($activeCategories, $settingsDB);
        quickAddTaxRateId =
            get(taxRatesDB).find((t: any) => t.isDefault)?.id || "tax-standard-vat";
        showQuickAddModal = true;
    }

    function openQuickAdd() {
        void requirePermission(
            "open_items",
            "Quick add product",
            showAuthorizedQuickAdd,
            "product",
            notFoundBarcode,
            `Create product from unknown barcode ${notFoundBarcode}`,
        );
    }

    function finishQuickAdd() {
        showQuickAddModal = false;
        quickAddAuthorized = false;
        searchQuery = "";
        notFoundBarcode = "";
        focusScannerSoon(true);
    }

    function closeQuickAdd() {
        if (quickAddBusy) return;
        finishQuickAdd();
    }

    function handleQuickAddBackdrop(event: MouseEvent) {
        if (event.target === event.currentTarget) closeQuickAdd();
    }

    function handleQuickAddPriceKey(key: string) {
        if (key === "C") {
            quickAddPrice = "0";
        } else if (key === "DEL" || key === "⌫") {
            quickAddPrice = quickAddPrice.length > 1 ? quickAddPrice.slice(0, -1) : "0";
        } else if (key === "00") {
            if (quickAddPrice !== "0" && quickAddPrice.length <= 7) quickAddPrice += "00";
        } else if (quickAddPrice.length < 9) {
            if (quickAddPrice === "0") quickAddPrice = key;
            else quickAddPrice += key;
        }
    }

    async function saveQuickProduct(printLabel = false) {
        if (quickAddBusy) return;
        if (!quickAddAuthorized) {
            finishQuickAdd();
            toast("Quick Add requires Items permission or manager approval", "error");
            return;
        }
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
            isAgeRestricted: quickAddAgeRestricted,
            isWeighable: false,
            showInGoods: false,
            goodsSortOrder: 0,
            color: randomTileColor(),
            image: "",
            isActive: true,
            createdAt: now(),
            updatedAt: now(),
        };

        quickAddBusy = true;
        try {
            await addProduct(newProduct);
            productsDB.update((ps) => [...ps, newProduct]);
            const addedToCart = addToCart(newProduct, "item", () => {
                if (!printLabel) toast("Product added and added to cart", "success");
            });
            finishQuickAdd();
            if (printLabel) {
                try {
                    const labelPrinter = getLabelPrinterConfig($settingsDB);
                    await printProductLabels({
                        product: newProduct,
                        store: $storeDB,
                        design: getLabelDesign($settingsDB),
                        quantity: 1,
                    }, labelPrinter);
                    toast(
                        addedToCart
                            ? "Product added and label sent to printer"
                            : "Product saved and label sent. Confirm a valid ID to add it to the cart",
                        addedToCart ? "success" : "info",
                    );
                } catch (printError) {
                    toast(`Product added, but label did not print: ${String(printError).replace(/^Error:\s*/, "")}`, "error");
                }
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

    function confirmClear() {
        if (cart.length > 0) {
            sendCctvAction({
                action: "CLEAR TROLLEY",
                name: `${cart.length} ${cart.length === 1 ? "line" : "lines"}`,
                amount: total,
            });
        }
        cart = [];
        selectedCartIndex = 0;
        clearTrolleyCustomer();
        showClearConfirm = false;
        showTrolleyFeedback("Cart cleared", "success");
    }

    async function openHeldOrders() {
        try { pendingHeldRecovery = activeHeldRecovery ? null : await loadHeldRecovery(); }
        catch (error) { toast(String(error), 'error'); }
        heldOrderView = "this";
        showHeldOrders = true;
    }

    async function recoverInterruptedTrolley() {
        if (cart.length || retrievingHeldOrderId) {
            toast('Finish or hold the current trolley before recovering another one.', 'error');
            return;
        }
        try {
            const draft = await loadHeldRecovery();
            if (!draft) return;
            retrievingHeldOrderId = draft.orderId;
            if (await heldRecoverySaleCompleted(draft.saleIds)) {
                await persistHeldRecovery(null);
                pendingHeldRecovery = null;
                toast('This trolley already has a saved receipt. It has not been restored or charged again.', 'success');
                return;
            }
            if (!await claimHeldOrder(draft.orderId, draft.claimId, draft.serverDataEpoch)) {
                await persistHeldRecovery(null);
                pendingHeldRecovery = null;
                toast('This trolley was retrieved on another till.', 'error');
                return;
            }
            try { await removeSql('orders', draft.orderId); }
            catch (error) {
                if ($connectionState.mode !== 'multi') throw error;
                console.warn('Held trolley cleanup will finish on sync:', error);
            }
            cart = draft.cart as typeof cart;
            selectedCustomerId = draft.customerId;
            selectedManualDiscountId = draft.discountId;
            activeHeldRecovery = draft;
            pendingHeldRecovery = null;
            showHeldOrders = false;
            showTrolleyFeedback('Interrupted trolley recovered.', 'success');
            void triggerSync();
        } catch (error) { toast(`Recovery kept for retry: ${String(error)}`, 'error'); }
        finally { retrievingHeldOrderId = ''; }
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
            customerId: selectedCustomerId,
            employeeId: $currentEmployee?.id || "",
            orderNumber: 0,
            receiptKey: '',
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
            await saveHeldOrderBundle(newOrder, lines, !!activeHeldRecovery);
            activeHeldRecovery = null;
            pendingHeldRecovery = null;
            heldRecoveryWriteError = '';
            let sharedAcrossTills = $connectionState.mode !== "multi";
            if ($connectionState.mode === "multi" && $connectionState.mysqlOnline) {
                try {
                    await flushOfflineQueue();
                    await assertHeldOrderUploadComplete(orderId);
                    sharedAcrossTills = true;
                } catch (syncError) {
                    console.warn("Held order is waiting to synchronize:", syncError);
                }
            }
            if (!newOrder.tillNumber || newOrder.tillNumber === tillId) {
                heldOrdersForTill = [enrichOrderSummary(newOrder as Order), ...heldOrdersForTill];
                heldOrderLinesByOrder = new Map(heldOrderLinesByOrder).set(orderId, lines as OrderLine[]);
            }
            sendCctvAction({
                action: "HOLD TROLLEY",
                name: `${cart.length} ${cart.length === 1 ? "line" : "lines"}`,
                amount: total,
            });
            cart = [];
            selectedCartIndex = 0;
            clearTrolleyCustomer();
            showTrolleyFeedback(
                $connectionState.mode === "multi"
                    ? sharedAcrossTills
                        ? "Trolley held and shared across tills"
                        : "Trolley held on this till and will share when sync reconnects"
                    : "Trolley held successfully",
                "success",
            );
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
        if (retrievingHeldOrderId) return;
        if (cart.length > 0) {
            toast(
                "Cannot retrieve while trolley has items. Please clear trolley first.",
                "error",
            );
            return;
        }
        if ($connectionState.mode === "multi" && !$connectionState.mysqlOnline) {
            toast("The main database must be online to safely retrieve a shared trolley", "error");
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
        retrievingHeldOrderId = orderId;
        let recovery: HeldRecovery | null = null;
        try {
            const pending = await loadHeldRecovery();
            if (pending) throw new Error('Recover the interrupted trolley first using the recovery button.');
            const claim = await prepareHeldOrderClaim();
            recovery = { orderId, ...claim, cart: restoredCart, customerId: heldOrder?.customerId || '', discountId: heldOrder?.discountId || '', saleIds: [] };
            // The durable local journal must commit BEFORE the shared row
            // can be deleted. An uncertain claim is retried with the same ID.
            await persistHeldRecovery(recovery);
            pendingHeldRecovery = recovery;
            const claimed = await claimHeldOrder(orderId, recovery.claimId, recovery.serverDataEpoch);
            if (!claimed) {
                await persistHeldRecovery(null);
                pendingHeldRecovery = null;
                heldOrdersForTill = heldOrdersForTill.filter((order) => order.id !== orderId);
                const staleLines = new Map(heldOrderLinesByOrder);
                staleLines.delete(orderId);
                heldOrderLinesByOrder = staleLines;
                toast("This trolley was already retrieved on another till", "error");
                void triggerSync();
                return;
            }
            // Cascade delete in SQLite (order_lines.orderId has ON DELETE CASCADE).
            try {
                await removeSql("orders", orderId);
            } catch (cleanupError) {
                if ($connectionState.mode !== "multi") throw cleanupError;
                // The server claim already produced a tombstone, so local cleanup
                // will finish on the next sync without losing the restored trolley.
                console.warn("Held order local cleanup is waiting for sync:", cleanupError);
            }
        } catch (e) {
            console.error(e);
            toast(`Could not retrieve this trolley: ${String(e).replace(/^Error:\s*/, '')}`, "error");
            return;
        } finally {
            retrievingHeldOrderId = "";
        }
        cart = restoredCart;
        activeHeldRecovery = recovery;
        pendingHeldRecovery = null;
        clearTrolleyCustomer();
        selectedCustomerId = heldOrder?.customerId || "";
        sendCctvAction({
            action: "RETRIEVE TROLLEY",
            name: `${restoredCart.length} ${restoredCart.length === 1 ? "line" : "lines"}`,
            amount: Math.max(0, Number(heldOrder?.total || 0)),
        });
        selectedManualDiscountId = $discountsDB.some((discount) =>
            discount.id === heldOrder?.discountId && discount.kind === "manual_percent" && discount.isActive
        ) ? heldOrder!.discountId : "";
        selectedCartIndex = 0;
        heldOrdersForTill = heldOrdersForTill.filter((order) => order.id !== orderId);
        const nextHeldLines = new Map(heldOrderLinesByOrder);
        nextHeldLines.delete(orderId);
        heldOrderLinesByOrder = nextHeldLines;
        showHeldOrders = false;
        showTrolleyFeedback(
            heldOrder?.tillNumber && heldOrder.tillNumber !== tillId
                ? `Trolley retrieved from ${heldOrder.tillName || heldOrder.tillNumber}`
                : "Trolley retrieved",
            "success",
        );
        void triggerSync();
    }

    function openChangePrice() {
        if (cart[selectedCartIndex]) {
            const product = $productById.get(cart[selectedCartIndex].id);
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
            sendCctvCartAction("PRICE", cart[selectedCartIndex]);
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
            const cartIndex = selectedCartIndex;
            const currentItem = cart[cartIndex];
            const updatedItem = { ...currentItem, price: newPence };
            try {
                let product = $productById.get(updatedItem.id);
                if (!product) {
                    const rows = await getProductsByIds([updatedItem.id], false, false);
                    product = rows[0] as Product | undefined;
                }
                if (!product) {
                    toast("This item is no longer available", "error");
                    return;
                }
                await updateProductFields(
                    { id: updatedItem.id, price: newPence },
                    { price: product.price },
                );
                rememberProductInPosCache({ ...product, price: newPence });
                if (cart[cartIndex]?.id !== currentItem.id) {
                    toast("The selected trolley item changed. Please try again.", "error");
                    return;
                }
                cart[cartIndex] = updatedItem;
                cart = [...cart];
                sendCctvCartAction("PRICE", cart[cartIndex]);
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
        } else if (key === "DEL" || key === "⌫") {
            goodsPriceString = goodsPriceString.length > 1 ? goodsPriceString.slice(0, -1) : "0";
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

        addToCart({
            id: product.id,
            name: product.name,
            price: newPence,
            forceSeparateLine: true,
            note: "",
        }, "item", () => {
            showGoodsModal = false;
            goodsPriceString = "0";
        });
    }
    let heldOrdersForTill: PosOrderSummary[] = [];
    let heldOrderLinesByOrder = new Map<string, OrderLine[]>();
    let heldOrdersLoading = false;
    let retrievingHeldOrderId = "";
    let posSummaryTillKey = "";
    let heldOrderLoadToken = 0;
    let latestReceiptLoadToken = 0;
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

    function groupPaymentsByOrderId(payments: Payment[]): Map<string, Payment[]> {
        const grouped = new Map<string, Payment[]>();
        for (const payment of payments) {
            const existing = grouped.get(payment.orderId) || [];
            existing.push(payment);
            grouped.set(payment.orderId, existing);
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

    async function refreshHeldOrderSummaries() {
        if (!tillId) return;
        if (!isTauri()) {
            heldOrdersForTill = [];
            heldOrderLinesByOrder = new Map();
            heldOrdersLoading = false;
            return;
        }
        const token = ++heldOrderLoadToken;
        heldOrdersLoading = true;
        try {
            const heldResult = await getPosHeldOrders(tillId);
            if (token !== heldOrderLoadToken) return;
            heldOrdersForTill = heldResult.orders as PosOrderSummary[];
            heldOrderLinesByOrder = groupLinesByOrderId(heldResult.lines as OrderLine[]);
        } catch (error) {
            console.warn("Could not refresh held trolleys:", error);
        } finally {
            if (token === heldOrderLoadToken) heldOrdersLoading = false;
        }
    }

    async function refreshLatestTillReceipt() {
        if (!tillId) return;
        const token = ++latestReceiptLoadToken;
        try {
            const latestReceipt = await getLatestTillReceipt(tillId);
            if (token === latestReceiptLoadToken) {
                latestTillReceiptOrder = latestReceipt as PosOrderSummary | null;
            }
        } catch (error) {
            console.warn("Could not refresh latest till receipt:", error);
        }
    }

    async function refreshPosOrderSummaries() {
        await Promise.all([refreshHeldOrderSummaries(), refreshLatestTillReceipt()]);
    }

    $: if (tillId && tillId !== posSummaryTillKey) {
        posSummaryTillKey = tillId;
        void refreshPosOrderSummaries();
    }
    $: ownHeldOrderCount = heldOrdersForTill.filter((order) => order.tillNumber === tillId).length;
    $: otherTillHeldOrderCount = heldOrdersForTill.length - ownHeldOrderCount;
    $: visibleHeldOrders = heldOrdersForTill.filter((order) =>
        heldOrderView === "this" ? order.tillNumber === tillId : order.tillNumber !== tillId
    );
    $: isMenuDisabled = cart.length > 0 || ownHeldOrderCount > 0;

    function handleMenuClick(path: string) {
        if (isMenuDisabled) {
            const msg =
                cart.length > 0
                    ? "You have products in the trolley"
                    : "You have held orders on this till";
            toast(msg, "error");
            return;
        }
        if ($employeesDB.length === 0) {
            goto("/setup");
            return;
        }
        if (!canAccessPath($currentEmployee, path, $settingsDB)) {
            const permission = permissionForPath(path);
            toast(permission ? `Your role cannot ${permissionLabels[permission].toLowerCase()}` : 'Your role cannot open the admin dashboard', 'error');
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
    let recentPaymentsByOrder = new Map<string, Payment[]>();
    let recentLoadToken = 0;
    const RECENT_RECEIPT_LIMIT = 10;
    $: scannerOverlayOpen =
        $toasts.some(isBlockingToast) ||
        showNumpad ||
        showChangePricePad ||
        showGoodsModal ||
        showHeldOrders ||
        showPaymentModal ||
        showCheckoutExpiryReview ||
        showDiscountModal ||
        showAppliedDiscounts ||
        showNotFoundModal ||
        showQuickAddModal ||
        showScaleModal ||
        showClearConfirm ||
        showReversalConfirm ||
        Boolean(pendingAgeRestrictedAdd) ||
        showManagerApprovalModal ||
        showPartialRefundPad ||
        showRecentTransactions ||
        isHoldingOrder ||
        isCompletingSale;
    $: if (!scannerOverlayOpen && $currentEmployee) {
        releaseScanFlowWaiters();
        focusScannerSoon();
    }
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
            recentPaymentsByOrder = groupPaymentsByOrderId(result.payments as Payment[]);
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

    function getCachedReceiptPayments(orderId: string): Payment[] {
        return recentPaymentsByOrder.get(orderId)
            || $paymentsDB.filter((payment) => payment.orderId === orderId);
    }

    async function getReceiptPrintData(orderId: string): Promise<{ lines: OrderLine[]; payments: Payment[] }> {
        const cachedLines = getCachedReceiptLines(orderId);
        const cachedPayments = getCachedReceiptPayments(orderId);
        if (cachedLines.length > 0 && cachedPayments.length > 0) {
            return { lines: cachedLines, payments: cachedPayments };
        }
        const details = await getOrderDetails(orderId);
        return {
            lines: cachedLines.length > 0 ? cachedLines : details.lines as OrderLine[],
            payments: cachedPayments.length > 0 ? cachedPayments : details.payments as Payment[],
        };
    }

    async function printStoredReceipt(selectedOrder: any, successMessage = "Receipt sent to printer") {
        try {
            const receiptData = await getReceiptPrintData(selectedOrder.id);
            await printEscposReceipt({
                store: $storeDB,
                order: selectedOrder,
                lines: receiptData.lines.map((line) => ({
                    ...line,
                    sku: $productById.get(line.productId)?.sku || "",
                })),
                payments: receiptData.payments,
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
        try {
            await printEscposReceipt({
                store: $storeDB,
                order: bundle.order,
                lines: bundle.lines.map((line) => ({
                    ...line,
                    sku: line.sku || $productById.get(line.productId)?.sku || "",
                })),
                payments: [bundle.payment],
                cashierName: employeeById.get(bundle.order.employeeId)?.name || $currentEmployee?.name || "",
                tillName: registerById.get(bundle.order.tillNumber)?.name || tillName,
                design: receiptDesign,
            }, receiptPrinterConfig);
            toast("Receipt sent to printer", "success");
        } catch (error) {
            toast(`Receipt did not print: ${error}`, "error");
        }
    }

    async function handleOpenCashDrawer(authorized = false) {
        if (drawerBusy) return;
        if (!authorized) {
            await requirePermission(
                "open_cash_drawer",
                "Open cash drawer",
                () => handleOpenCashDrawer(true),
                "cash_drawer",
                tillId || "local",
                `Manual drawer opening on ${tillName || tillId || "this till"}`,
            );
            return;
        }
        if (!cashDrawerTarget) {
            toast("Set the receipt printer in Settings first", "error");
            return;
        }
        drawerBusy = true;
        try {
            await openCashDrawer(cashDrawerConfig);
            toast("Drawer opened");
            try {
                await recordAuditEvent(
                    "cash_drawer_opened",
                    "cash_drawer",
                    tillId || "local",
                    null,
                    { tillName, target: cashDrawerTarget, source: "manual" },
                );
            } catch (auditError) {
                console.warn("Drawer opened, but its audit entry could not be saved:", auditError);
                toast("Drawer opened, but the audit entry could not be saved", "error");
            }
        } catch (error) {
            toast(`Drawer failed: ${error}`, "error");
        } finally {
            drawerBusy = false;
        }
    }

    async function openDrawerAfterSuccessfulPayment(cashAmount: number, transactionLabel = "Sale") {
        if (!receiptPrinterConfig.openDrawerAfterPayment || cashAmount <= 0) return;
        try {
            await openCashDrawer(cashDrawerConfig);
        } catch (error) {
            console.warn("Drawer failed after payment:", error);
            toast(`${transactionLabel} completed, but drawer did not open: ${error}`, "error");
        }
    }

    async function printReceiptAfterSuccessfulPayment(bundle: SaleBundle, transactionLabel = "Sale") {
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
            toast(`${transactionLabel} completed, but receipt did not print: ${error}`, "error");
        }
    }

    function dojoPaymentIntentId(payments: Payment[]): string {
        for (const payment of payments) {
            const match = String(payment.reference || "").match(/\[id:(pi_[^\]]+)\]/i);
            if (match?.[1]) return match[1];
        }
        return "";
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
        const originalHasCardExtras = originalPayments.some((entry) =>
            Number(entry.tipsAmount || 0) > 0
            || Number(entry.serviceChargeAmount || 0) > 0
            || Number(entry.cashbackAmount || 0) > 0);
        if (voiding && originalHasCardExtras) {
            toast("This sale includes tips, service charge or cashback. Do not void it: use a goods-only refund and reconcile the additional amounts separately.", "error");
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
        if (voiding && original.shiftId !== $currentShiftId) {
            toast("Void is only available during the original open till session. Use Refund for an older sale.", "error");
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
            notes: voiding ? `Void of receipt ${original.orderNumber}`
                : `Refund of receipt ${original.orderNumber}${originalHasCardExtras ? ' · Goods only; tips, service charge and cashback are unchanged' : ''}`,
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
        const refundCustomerAccount = paymentAllocation.accountAmount > 0 && original.customerId
            ? await getCustomerAccount(original.customerId)
            : null;
        if (paymentAllocation.accountAmount > 0 && !refundCustomerAccount) {
            toast("The customer account for this Pay later refund could not be found", "error");
            return;
        }
        const payment = {
            id: uuid(),
            orderId: reversalId,
            method: paymentAllocation.method,
            amount: -refundAmount,
            cashAmount: -paymentAllocation.cashAmount,
            cardAmount: -paymentAllocation.cardAmount,
            loyaltyAmount: -paymentAllocation.loyaltyAmount,
            accountAmount: -paymentAllocation.accountAmount,
            reference: voiding ? "VOID" : "REFUND",
            changeGiven: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        const originalSumupPayments = originalPayments.filter((entry) =>
            Math.abs(Number(entry.cardAmount || 0)) > 0
            && (String(entry.method || "").includes("sumup") || String(entry.reference || "").startsWith("SumUp "))
        );
        const originalDojoPayments = originalPayments.filter((entry) =>
            Math.abs(Number(entry.cardAmount || 0)) > 0
            && (String(entry.method || "").includes("dojo") || String(entry.reference || "").startsWith("Dojo "))
        );
        const sumupRefundAmount = originalSumupPayments.length > 0 ? paymentAllocation.cardAmount : 0;
        const dojoRefundAmount = originalDojoPayments.length > 0 ? paymentAllocation.cardAmount : 0;
        const previousSumupRefundAmount = sumupRefundAmount > 0
            ? previousReversalPayments
                .filter((entry) => String(entry.method || "").includes("sumup") || String(entry.reference || "").startsWith("SumUp "))
                .reduce((sum, entry) => sum + Math.abs(Number(entry.cardAmount || 0)), 0)
            : 0;
        const previousDojoRefundAmount = dojoRefundAmount > 0
            ? previousReversalPayments
                .filter((entry) => String(entry.method || "").includes("dojo") || String(entry.reference || "").startsWith("Dojo "))
                .reduce((sum, entry) => sum + Math.abs(Number(entry.cardAmount || 0)), 0)
            : 0;
        if (sumupRefundAmount > 0) {
            payment.method = paymentAllocation.cashAmount > 0 ? "split+sumup" : "sumup";
        } else if (dojoRefundAmount > 0) {
            payment.method = paymentAllocation.cashAmount > 0 ? "split+dojo" : "dojo";
        }
        // Keep the accounting method on the payment row, but make the receipt
        // explicit when part of the refund is credited back to Pay Later or
        // loyalty value. Mixed refunds would otherwise print only "SPLIT".
        reversalOrder.paymentMethod = [
            payment.method,
            paymentAllocation.loyaltyAmount > 0 && !String(payment.method).includes('loyalty') ? 'loyalty' : '',
            paymentAllocation.accountAmount > 0 && !String(payment.method).includes('account') ? 'account' : '',
        ].filter(Boolean).join('+');
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
        const accountChanges = paymentAllocation.accountAmount > 0 && refundCustomerAccount ? [{
            id: uuid(),
            accountId: refundCustomerAccount.id,
            customerId: original.customerId,
            orderId: reversalId,
            entryType: 'refund' as const,
            amountPence: -paymentAllocation.accountAmount,
            paymentMethod: '' as const,
            reference: `Refund of receipt ${original.orderNumber}`,
            description: `${voiding ? 'Void' : 'Refund'} credited to customer account`,
            receiptNumber: 0,
            receiptKey: '',
            employeeId: $currentEmployee?.id || '',
            tillNumber: tillId,
            shiftId: $currentShiftId,
            idempotencyKey: `refund-account:${reversalId}`,
            reversesEntryId: '',
            balanceAfterPence: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
        }] : [];
        let reversalBundle: SaleBundle = {
            order: reversalOrder,
            lines: reversalLines,
            payment,
            stockChanges,
            loyaltyChanges,
            accountChanges,
            audit: {
                id: uuid(),
                employeeId: $currentEmployee?.id || "",
                action: voiding ? "order_voided" : partial ? "order_partially_refunded" : "order_refunded",
                entityType: "order",
                entityId: original.id,
                oldData: JSON.stringify({ status: original.status }),
                newData: JSON.stringify({ status, refundAmount, reversalId, accountRefund: paymentAllocation.accountAmount }),
                createdAt: timestamp,
            },
            originalOrderToUpdate: original.id,
            originalStatusUpdate: status,
        };
        let managedRefundApproved: "sumup" | "dojo" | null = null;
        try {
            isReversingOrder = true;
            if (sumupRefundAmount > 0 || dojoRefundAmount > 0) {
                await requireManualSaleAccess();
            }
            if (sumupRefundAmount > 0) {
                const activeSumupConfig = get(sumupConfigStore);
                if (!activeSumupConfig.enabled || !activeSumupConfig.ready) {
                    throw new Error("This sale used SumUp. Enable the correct SumUp merchant on this till before refunding it.");
                }
                reversalBundle = await processManagedSumupRefund(
                    activeSumupConfig,
                    reversalBundle,
                    original.id,
                    originalSumupPayments.reduce((sum, entry) => sum + Math.abs(Number(entry.cardAmount || 0)), 0),
                    previousSumupRefundAmount,
                    sumupRefundAmount,
                    voiding,
                );
                managedRefundApproved = "sumup";
            } else if (dojoRefundAmount > 0) {
                const activeDojoConfig = get(dojoConfigStore);
                if (!activeDojoConfig.enabled || !activeDojoConfig.ready) {
                    throw new Error("This sale used Dojo. Enable the correct Dojo account on this till before refunding it.");
                }
                const paymentIntentId = dojoPaymentIntentId(originalDojoPayments);
                if (!paymentIntentId) {
                    throw new Error("The original Dojo payment-intent ID is missing. No refund was sent.");
                }
                reversalBundle = await processManagedDojoRefund(
                    activeDojoConfig,
                    reversalBundle,
                    paymentIntentId,
                    originalDojoPayments.reduce((sum, entry) => sum + Math.abs(Number(entry.cardAmount || 0)), 0),
                    previousDojoRefundAmount,
                    dojoRefundAmount,
                    voiding,
                );
                managedRefundApproved = "dojo";
            }
            const committedReversal = await commitSale(reversalBundle);
            if (managedRefundApproved === "sumup") {
                await updateSumupAttempt(reversalId, "completed", { saleBundle: committedReversal });
            } else if (managedRefundApproved === "dojo") {
                await updateDojoAttempt(reversalId, "completed", { saleBundle: committedReversal });
            }
            // Browser preview commits directly into its in-memory stores;
            // native commits return a bundle for the UI stores to apply.
            if (isTauri()) applyCompletedSaleToStores(committedReversal);
            if (paymentAllocation.cashAmount > 0) {
                void openDrawerAfterSuccessfulPayment(paymentAllocation.cashAmount, voiding ? "Void" : "Refund");
            }
            void printReceiptAfterSuccessfulPayment(committedReversal, voiding ? "Void" : "Refund");
            sendCompletedBundleToCctv(
                committedReversal,
                voiding ? "VOID" : partial ? "PARTIAL REFUND" : "REFUND",
            );
            await refreshPosOrderSummaries();
            toast(voiding ? "Order voided and reversed"
                : originalHasCardExtras ? "Goods refund recorded. Tips, service charge and cashback are unchanged."
                : "Refund recorded", "success");
            await openRecentTransactions();
        } catch (e) {
            if (managedRefundApproved) {
                const updateAttempt = managedRefundApproved === "dojo" ? updateDojoAttempt : updateSumupAttempt;
                await updateAttempt(reversalId, "commit_failed", {
                    error: String(e),
                    saleBundle: reversalBundle,
                }).catch(() => undefined);
                toast(`${managedRefundApproved === "dojo" ? "Dojo" : "SumUp"} accepted the card refund. The POS record will save automatically when the database is ready. Do not refund it again.`, "error");
                setTimeout(() => void (managedRefundApproved === "dojo" ? recoverApprovedDojoSales() : recoverApprovedSumupSales()), 2_000);
            } else {
                toast(`Reversal failed: ${e}`, "error");
            }
        } finally {
            isReversingOrder = false;
            pendingReversal = null;
            partialRefundInput = "";
            showReversalConfirm = false;
            showPartialRefundPad = false;
        }
    }

    function requestReversal(orderId: string, partial: boolean, voiding: boolean) {
        if ($connectionState.mode === "multi" && !$connectionState.mysqlOnline) {
            toast("Refunds and voids require the main database to be online so another till cannot reverse the same sale.", "error");
            return;
        }
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
    let cashShortcutBusy = false;

    function calculateQuickAmounts(tPence: number) {
        let nextPound = Math.ceil(tPence / 100) * 100;
        nextPoundAmount = nextPound > tPence ? nextPound : null;
    }

    $: if (showPaymentModal && !hasTypedPayment) {
        calculateQuickAmounts(paymentDue);
    }

    async function openPayment() {
        if (cart.length === 0) {
            toast("Cart is empty", "error");
            return;
        }
        refreshPromotionClock();
        await tick();
        const retainedCustomer = selectedCustomer;
        amountTenderedString = "0";
        paymentMethod = "cash";
        hasTypedPayment = false;
        terminalPaymentStage = "idle";
        terminalPaymentMessage = "";
        terminalCancelRequested = false;
        customerSearch = "";
        paymentCustomerSearchOpen = false;
        selectedCustomerAccount = null;
        customerAccountLoadToken += 1;
        customerAccountBusy = false;
        customerAccountLoadError = false;
        useLoyaltyCredit = false;
        calculateQuickAmounts(total);
        showPaymentModal = true;
        if (retainedCustomer) {
            void selectPaymentCustomer(retainedCustomer);
        } else {
            if (selectedCustomerId) clearTrolleyCustomer();
        }
    }

    async function togglePaymentCustomerSearch() {
        if (isCompletingSale) return;
        paymentCustomerSearchOpen = !paymentCustomerSearchOpen;
        customerSearch = "";
        if (paymentCustomerSearchOpen) {
            await tick();
            customerSearchInput?.focus({ preventScroll: true });
        } else {
            document.dispatchEvent(new Event("close-touch-keyboard"));
        }
    }

    function closePayment() {
        if (isCompletingSale || cashShortcutBusy || loyaltyCreditBusy || showNewPaymentCustomer || newPaymentCustomerSaving) return;
        customerAccountLoadToken += 1;
        customerAccountBusy = false;
        customerAccountLoadError = false;
        showPaymentModal = false;
    }

    function openNewPaymentCustomer() {
        if (isCompletingSale || cashShortcutBusy || loyaltyCreditBusy || newPaymentCustomerSaving) return;
        document.dispatchEvent(new Event('close-touch-keyboard'));
        void requirePermission('open_customers', 'Add customer at checkout', () => {
            if (!showPaymentModal || isCompletingSale) return;
            newPaymentCustomer = newCheckoutCustomerDraft($customersDB);
            newPaymentCustomerError = '';
            newPaymentCustomerAuthorized = true;
            showNewPaymentCustomer = true;
        }, 'customer', '', 'Register a new customer during checkout');
    }

    function closeNewPaymentCustomer() {
        if (newPaymentCustomerSaving) return;
        document.dispatchEvent(new Event('close-touch-keyboard'));
        showNewPaymentCustomer = false;
        newPaymentCustomerAuthorized = false;
        newPaymentCustomer = null;
        newPaymentCustomerError = '';
        tick().then(() => paymentCustomerToggle?.focus({ preventScroll: true }));
    }

    async function saveNewPaymentCustomer() {
        if (newPaymentCustomerSaving || isCompletingSale || !newPaymentCustomer || !showPaymentModal) return;
        if (!newPaymentCustomerAuthorized) { newPaymentCustomerError = 'Customer permission or manager approval is required.'; return; }
        newPaymentCustomerSaving = true;
        newPaymentCustomerError = '';
        try {
            const customer = await registerCheckoutCustomer(newPaymentCustomer, {
                multi: $connectionState.mode === 'multi', online: $connectionState.mysqlOnline,
                codeInUse: isCustomerLoyaltyCodeInUse, persist: saveCustomerProfile,
            });
            // A retry keeps its original UUID; never add a second store row.
            customersDB.update(list => [...list.filter(existing => existing.id !== customer.id), customer]);
            showNewPaymentCustomer = false;
            newPaymentCustomerAuthorized = false;
            newPaymentCustomer = null;
            await selectPaymentCustomer(customer);
        } catch (error) {
            newPaymentCustomerError = String(error).replace(/^Error:\s*/, '');
        } finally { newPaymentCustomerSaving = false; }
    }

    function cancelManagerApproval() {
        showManagerApprovalModal = false;
        managerApprovalPin = "";
        managerApprovalError = "";
        managerApprovalAction = null;
    }

    function cancelPartialRefund() {
        if (isReversingOrder) return;
        showPartialRefundPad = false;
        pendingReversal = null;
        partialRefundInput = "";
    }

    function closeTopPosModal(): boolean {
        if (showNewPaymentCustomer) {
            if (newPaymentCustomerSaving) return false;
            closeNewPaymentCustomer();
            return true;
        }
        if (pendingAgeRestrictedAdd) {
            cancelAgeRestrictedAdd();
            return true;
        }
        if (showManagerApprovalModal) {
            cancelManagerApproval();
            return true;
        }
        if (showPartialRefundPad) {
            if (isReversingOrder) return false;
            cancelPartialRefund();
            return true;
        }
        if (showQuickAddModal) {
            if (quickAddBusy) return false;
            closeQuickAdd();
            return true;
        }
        if (showNotFoundModal) {
            dismissNotFoundModal();
            return true;
        }
        if (showPaymentModal) {
            if (isCompletingSale) return false;
            closePayment();
            return true;
        }
        if (showRecentTransactions) {
            if (isReversingOrder) return false;
            showRecentTransactions = false;
            return true;
        }
        if (showHeldOrders) {
            showHeldOrders = false;
            return true;
        }
        if (showGoodsModal) {
            showGoodsModal = false;
            return true;
        }
        if (showChangePricePad) {
            showChangePricePad = false;
            return true;
        }
        if (showNumpad) {
            showNumpad = false;
            return true;
        }
        if (showScaleModal) {
            closeScaleModal();
            return true;
        }
        if (showDiscountModal) {
            showDiscountModal = false;
            return true;
        }
        if (showAppliedDiscounts) {
            showAppliedDiscounts = false;
            return true;
        }
        return false;
    }

    function handleModalKeydown(event: KeyboardEvent) {
        if (handleLoginKeydown(event)) return;
        if (
            showPaymentModal &&
            !showNewPaymentCustomer && !newPaymentCustomerSaving &&
            paymentMethod === "cash" &&
            !isCompletingSale &&
            !event.defaultPrevented &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !(event.target as HTMLElement | null)?.matches("input, textarea, select, [contenteditable='true']")
        ) {
            if (/^\d$/.test(event.key)) {
                event.preventDefault();
                handlePaymentPadKey(event.key);
                return;
            }
            if (event.key === "Backspace" || event.key === "Delete") {
                event.preventDefault();
                handlePaymentPadKey("⌫");
                return;
            }
        }
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (!closeTopPosModal()) return;
        event.preventDefault();
        event.stopPropagation();
    }

    function handleModalBackdropPointerDown(event: PointerEvent) {
        const target = event.target as HTMLElement | null;
        if (!target?.matches(".modal-overlay, [data-pos-modal-overlay]")) return;
        if (closeTopPosModal()) event.preventDefault();
    }

    async function selectPaymentCustomer(customer: Customer) {
        if (isCompletingSale || cashShortcutBusy || loyaltyCreditBusy) return;
        const customerId = customer.id;
        const loadToken = ++customerAccountLoadToken;
        selectedCustomerId = customer.id;
        selectedCustomerAccount = null;
        customerAccountLoadError = false;
        customerSearch = "";
        paymentCustomerSearchOpen = false;
        document.dispatchEvent(new Event("close-touch-keyboard"));
        tick().then(() => paymentCustomerToggle?.focus({ preventScroll: true }));
        useLoyaltyCredit = false;
        amountTenderedString = "0";
        hasTypedPayment = false;
        calculateQuickAmounts(total);
        customerAccountBusy = true;
        try {
            const account = await getCustomerAccount(customerId);
            if (loadToken !== customerAccountLoadToken || selectedCustomerId !== customerId) return;
            selectedCustomerAccount = account;
        } catch (error) {
            if (loadToken !== customerAccountLoadToken || selectedCustomerId !== customerId) return;
            customerAccountLoadError = true;
            console.warn("Could not load customer account:", error);
            toast(`Could not load customer account: ${String(error).replace(/^Error:\s*/, "")}`, "error");
        } finally {
            if (loadToken === customerAccountLoadToken && selectedCustomerId === customerId) {
                customerAccountBusy = false;
            }
        }
    }

    function handleCustomerSearchKeydown(event: KeyboardEvent) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        const input = event.currentTarget as HTMLInputElement;
        const loyaltyCode = input.value.trim().toLowerCase();
        const exact = $customersDB.find((customer) =>
            customer.loyaltyCode?.toLowerCase() === loyaltyCode,
        );
        if (exact) {
            void selectPaymentCustomer(exact);
            input.value = "";
        }
    }

    async function toggleLoyaltyCredit() {
        if (isCompletingSale || cashShortcutBusy || loyaltyCreditBusy || !selectedCustomer) return;
        const enabling = !useLoyaltyCredit;
        if (enabling && $connectionState.mode === "multi") {
            loyaltyCreditBusy = true;
            try {
                const refreshed = await getPaymentCustomer(selectedCustomer.id);
                if (!refreshed) {
                    toast("This customer no longer exists in the shared database", "error");
                    loyaltyCreditBusy = false;
                    removePaymentCustomer();
                    return;
                }
                customersDB.update((customers) => customers.map((customer) =>
                    customer.id === refreshed.id ? refreshed as Customer : customer
                ));
                await tick();
            } catch (error) {
                toast(`Could not check loyalty credit: ${error}`, "error");
                return;
            } finally {
                loyaltyCreditBusy = false;
            }
        }
        if (enabling && availableLoyaltyCredit <= 0) {
            toast("This customer has no loyalty credit available", "info");
            return;
        }
        useLoyaltyCredit = enabling;
        amountTenderedString = "0";
        hasTypedPayment = false;
        calculateQuickAmounts(enabling ? Math.max(0, total - Math.min(total, availableLoyaltyCredit)) : total);
    }

    function clearTrolleyCustomer() {
        customerAccountLoadToken += 1;
        customerSearch = "";
        selectedCustomerId = "";
        selectedCustomerAccount = null;
        customerAccountBusy = false;
        customerAccountLoadError = false;
        useLoyaltyCredit = false;
        loyaltyCreditBusy = false;
    }

    function removePaymentCustomer() {
        if (isCompletingSale || cashShortcutBusy || loyaltyCreditBusy) return;
        clearTrolleyCustomer();
        if (paymentMethod === "account") paymentMethod = "cash";
        amountTenderedString = "0";
        hasTypedPayment = false;
        calculateQuickAmounts(total);
        tick().then(() => paymentCustomerToggle?.focus({ preventScroll: true }));
    }

    function handlePaymentPadKey(key: string) {
        if (isCompletingSale || cashShortcutBusy) return;
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
        if (isCompletingSale || cashShortcutBusy || loyaltyCreditBusy || !showPaymentModal || paymentMethod !== 'cash'
            || showNewPaymentCustomer || newPaymentCustomerSaving) return;
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_ORDER_TOTAL_PENCE) {
            toast('Payment amount is invalid or too large', 'error');
            return;
        }
        // Lock before yielding so repeated note/exact-payment taps cannot submit twice.
        cashShortcutBusy = true;
        try {
            amountTenderedString = amount.toString();
            hasTypedPayment = true;
            await tick();
            await completeSale();
        } finally {
            cashShortcutBusy = false;
        }
    }

    async function addQuickAmount(amount: number) {
        if (isCompletingSale || cashShortcutBusy || loyaltyCreditBusy || paymentDue <= 0 || !showPaymentModal || paymentMethod !== 'cash'
            || showNewPaymentCustomer || newPaymentCustomerSaving) return;
        try {
            const plan = planBanknotePayment(
                hasTypedPayment ? Number(amountTenderedString) : 0,
                amount, paymentDue, MAX_ORDER_TOTAL_PENCE,
            );
            if (plan.shouldComplete) {
                await setAmountAndComplete(plan.tenderedPence);
            } else {
                amountTenderedString = plan.tenderedPence.toString();
                hasTypedPayment = true;
            }
        } catch (error) {
            toast(String(error).replace(/^Error:\s*/, ''), 'error');
        }
    }

    function selectPaymentMethod(method: "cash" | "card" | "account") {
        if (isCompletingSale || cashShortcutBusy) return;
        if (method === "account" && !accountSaleAvailable) {
            if (!selectedCustomer) {
                if (!paymentCustomerSearchOpen) void togglePaymentCustomerSearch();
            }
            else if (customerAccountBusy) toast("Wait while the customer account is checked", "info");
            else if (customerAccountLoadError) toast("The customer account could not be verified. Remove and select the customer again to retry", "error");
            else if (paymentDue <= 0) toast("Nothing remains to charge to the customer account", "info");
            else if (!selectedCustomerAccount?.isEnabled) toast("Pay later is not enabled for this customer", "error");
            else if (!accountLimitAllowsSale) toast("This sale would exceed the customer's account limit", "error");
            else if ($connectionState.mode === "multi" && !$connectionState.mysqlOnline) toast("MariaDB must be online for Pay later", "error");
            else if (!hasPermission($currentEmployee, "charge_customer_account", $settingsDB)) toast("You do not have permission to charge customer accounts", "error");
            return;
        }
        paymentMethod = method;
        paymentCustomerSearchOpen = false;
        customerSearch = "";
        document.dispatchEvent(new Event("close-touch-keyboard"));
        if (method === "account" || (method === "card" && paymentInputAmount >= paymentDue)) {
            amountTenderedString = "0";
            hasTypedPayment = false;
        }
    }

    function clearPaymentInput() {
        if (isCompletingSale || cashShortcutBusy) return;
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
            recentPaymentsByOrder = new Map(recentPaymentsByOrder).set(order.id, [bundle.payment as Payment]);
            if (order.tillNumber === tillId) latestTillReceiptOrder = summary;
        }
    }

    function sumupReaderMessage(state: string): string {
        switch (state) {
            case "SELECTING_TIP": return "Waiting for the customer to choose a tip";
            case "WAITING_FOR_CARD": return "Ask the customer to tap or insert their card";
            case "WAITING_FOR_PIN": return "Waiting for the customer to enter their PIN";
            case "WAITING_FOR_SIGNATURE": return "Waiting for the customer signature";
            case "UPDATING_FIRMWARE": return "The Solo is updating and cannot take payment yet";
            case "IDLE": return "Payment sent. Waiting for the Solo to start";
            default: return "Waiting for the SumUp Solo";
        }
    }

    function verifySumupApproval(
        status: SumupTransactionStatus,
        expectedReference: string,
        expectedAmount: number,
        expectedCurrency: string,
    ) {
        if (status.foreignTransactionId !== expectedReference) {
            throw new Error("SumUp approved a transaction with a different sale reference. Do not retry the card; check SumUp transactions.");
        }
        if (status.amount === undefined || Math.round(status.amount * 100) !== expectedAmount) {
            throw new Error("SumUp returned a different payment amount. Do not retry the card; check SumUp transactions.");
        }
        if ((status.currency || "").toUpperCase() !== expectedCurrency.toUpperCase()) {
            throw new Error("SumUp returned a different currency. Do not retry the card; check SumUp transactions.");
        }
        if (!status.transactionId) {
            throw new Error("SumUp approved the card but did not return its transaction ID. Do not retry the card; check SumUp transactions.");
        }
    }

    function dismissDojoSignatureDecision() {
        dojoSignatureDecision = null;
        showDojoSignatureConfirm = false;
    }

    function finishDojoSignatureDecision(accepted: boolean) {
        const decide = dojoSignatureDecision;
        dismissDojoSignatureDecision();
        decide?.(accepted);
    }

    function verifyDojoApproval(
        status: DojoPaymentIntentStatus,
        expectedPaymentIntentId: string,
        expectedReference: string,
        expectedAmount: number,
        expectedCurrency: string,
    ) {
        if (status.id !== expectedPaymentIntentId || status.reference !== expectedReference) {
            throw new Error("Dojo captured a payment with a different sale reference. Do not retry the card; check the Dojo portal.");
        }
        if (status.status !== "Captured") {
            throw new Error(`Dojo terminal completed but the payment intent is ${status.status}. Do not retry until it is checked.`);
        }
        return getDojoPaymentBreakdown(status, expectedAmount, expectedCurrency);
    }

    async function processManagedDojoPayment(
        config: DojoConfig,
        bundle: SaleBundle,
        amount: number,
    ): Promise<SaleBundle> {
        const reference = bundle.order.id;
        const attempt: DojoPaymentAttempt = {
            id: reference,
            provider: "dojo",
            terminalKey: dojoTerminalKey(config),
            clientTransactionId: "",
            terminalSessionId: "",
            operationKind: "sale",
            amount,
            expectedProviderAmount: amount,
            currency: config.currency,
            status: "prepared",
            saleBundle: bundle,
            providerReference: "",
            error: "",
            tillId,
            createdAt: now(),
            updatedAt: now(),
        };
        bundle = requirePreparedSaleBundle(await saveDojoAttempt(attempt));

        let lockHeld = false;
        let approved = false;
        let finalized = false;
        let networkStarted = false;
        let paymentIntentId = "";
        let terminalSessionId = "";
        terminalCancelRequested = false;
        terminalPaymentStage = "reserving";
        terminalPaymentMessage = "Reserving the shared Dojo terminal";

        try {
            const lockResult = await acquireDojoLock(config, tillId, tillName, reference);
            if (!lockResult.acquired) {
                const holder = lockResult.lock?.tillName || "another till";
                throw new Error(`The Dojo terminal is currently being used by ${holder}`);
            }
            lockHeld = true;
            terminalPaymentStage = "sending";
            terminalPaymentMessage = `Sending ${formatMoney(amount)} to ${config.terminalName || "Dojo terminal"}`;

            await updateDojoAttempt(reference, "started");
            await assertPaymentTerminalAttemptReady("dojo", reference);
            networkStarted = true;
            const payment = await createDojoPayment(amount, reference, `Sale from ${tillName || "POS"}`);
            paymentIntentId = payment.paymentIntentId;
            terminalSessionId = payment.terminalSessionId;
            activeDojoSessionId = terminalSessionId;
            await updateDojoAttempt(reference, "started", {
                clientTransactionId: paymentIntentId,
                terminalSessionId,
            });
            terminalPaymentStage = "waiting";
            terminalPaymentMessage = "Ask the customer to tap or insert their card";

            const result = await monitorDojoSession({
                paymentIntentId,
                terminalSessionId,
                apiEnvironment: config.apiEnvironment,
                retry: async () => {
                    const retried = await retryDojoPayment(reference, terminalSessionId);
                    terminalSessionId = retried.terminalSessionId;
                    activeDojoSessionId = terminalSessionId;
                    terminalCancelRequested = false;
                    return terminalSessionId;
                },
                onDeclined: (decide) => { dojoRetryDecision = decide; },
                onDeclineDismiss: () => { dojoRetryDecision = null; },
                getSession: () => getDojoTerminalSessionStatus(terminalSessionId),
                getPayment: () => getDojoPaymentIntentStatus(paymentIntentId),
                submitSignature: (accepted) => respondToDojoSignature(terminalSessionId, accepted),
                cancel: () => cancelDojoTerminalSession(terminalSessionId),
                refreshLease: () => refreshDojoLock(config, tillId, reference),
                shouldCancel: () => terminalCancelRequested,
                isDisposed: () => posDestroyed,
                onSignatureRequired: (decide) => {
                    dojoSignatureDecision = decide;
                    showDojoSignatureConfirm = true;
                },
                onSignatureDismiss: dismissDojoSignatureDecision,
                onMessage: (message, cancelling) => {
                    terminalPaymentMessage = message;
                    terminalPaymentStage = cancelling ? "cancelling" : "waiting";
                },
            });
            if (result.outcome !== "captured") {
                await updateDojoAttempt(reference, result.outcome, {
                    clientTransactionId: paymentIntentId,
                    terminalSessionId,
                    error: `Dojo status: ${result.status}`,
                });
                finalized = true;
                throw new Error(result.outcome === "cancelled" ? "The Dojo payment was cancelled" : "The card payment was not approved");
            }
            const paymentStatus = result.payment;
            const breakdown = verifyDojoApproval(paymentStatus, paymentIntentId, reference, amount, config.currency);
            bundle.payment.tipsAmount = breakdown.tipsAmount;
            bundle.payment.serviceChargeAmount = breakdown.serviceChargeAmount;
            bundle.payment.cashbackAmount = breakdown.cashbackAmount;
            const terminalReference = paymentStatus.transactionId || paymentIntentId;
            const loyaltyReference = bundle.payment.reference ? ` · ${bundle.payment.reference}` : "";
            bundle.payment.reference = `Dojo ${terminalReference} [id:${paymentIntentId}]${loyaltyReference}`;
            approved = true;
            terminalPaymentStage = "approved";
            terminalPaymentMessage = "Card approved. Saving the sale";
            await updateDojoAttempt(reference, "approved", {
                clientTransactionId: paymentIntentId,
                terminalSessionId,
                providerReference: `Dojo ${terminalReference} [id:${paymentIntentId}]`,
                saleBundle: bundle,
            }).catch((error) => {
                console.error("Could not update the approved Dojo recovery journal:", error);
            });
            return bundle;
        } catch (error) {
            if (!approved && !finalized) {
                const message = String(error);
                await updateDojoAttempt(reference, networkStarted ? "uncertain" : "cancelled", {
                    clientTransactionId: paymentIntentId,
                    terminalSessionId,
                    error: message,
                }).catch(() => undefined);
                if (message.includes('Dojo session expired') && $currentEmployee?.role === 'admin') {
                    checkoutExpiryAttempt = await refreshPaymentTerminalAttempt('dojo', reference).catch(() => null) as DojoPaymentAttempt | null;
                    if (checkoutExpiryAttempt) {
                        showPaymentModal = false;
                        showCheckoutExpiryReview = true;
                    }
                }
            }
            throw error;
        } finally {
            dismissDojoSignatureDecision();
            activeDojoSessionId = "";
            if (lockHeld) {
                await releaseDojoLock(config, tillId, reference).catch((error) => {
                    console.warn("Could not release Dojo terminal lock:", error);
                });
            }
        }
    }

    async function processManagedSumupPayment(
        config: SumupConfig,
        bundle: SaleBundle,
        amount: number,
    ): Promise<SaleBundle> {
        const reference = bundle.order.id;
        const attempt: SumupPaymentAttempt = {
            id: reference,
            provider: "sumup",
            terminalKey: sumupTerminalKey(config),
            clientTransactionId: "",
            terminalSessionId: "",
            operationKind: "sale",
            amount,
            expectedProviderAmount: amount,
            currency: config.currency,
            status: "prepared",
            saleBundle: bundle,
            providerReference: "",
            error: "",
            tillId,
            createdAt: now(),
            updatedAt: now(),
        };
        bundle = requirePreparedSaleBundle(await saveSumupAttempt(attempt));

        let lockHeld = false;
        let approved = false;
        let finalized = false;
        let networkStarted = false;
        let clientTransactionId = "";
        terminalCancelRequested = false;
        terminalPaymentStage = "reserving";
        terminalPaymentMessage = "Reserving the shared Solo";

        try {
            const lockResult = await acquireSumupLock(config, tillId, tillName, reference);
            if (!lockResult.acquired) {
                const holder = lockResult.lock?.tillName || "another till";
                throw new Error(`The SumUp Solo is currently being used by ${holder}`);
            }
            lockHeld = true;
            terminalPaymentStage = "sending";
            terminalPaymentMessage = `Sending ${formatMoney(amount)} to ${config.readerName || "SumUp Solo"}`;

            await updateSumupAttempt(reference, "started");
            await assertPaymentTerminalAttemptReady("sumup", reference);
            networkStarted = true;
            const checkout = await createSumupCheckout(
                amount,
                reference,
                `Sale from ${tillName || "POS"}`,
            );
            clientTransactionId = checkout.clientTransactionId;
            await updateSumupAttempt(reference, "started", { clientTransactionId });
            terminalPaymentStage = "waiting";
            terminalPaymentMessage = "Ask the customer to tap or insert their card";

            let deadline = Date.now() + 180_000;
            let nextReaderCheck = 0;
            let nextLeaseRefresh = Date.now() + 25_000;
            let cancellationSentAt = 0;
            while (Date.now() < deadline) {
                if (terminalCancelRequested && cancellationSentAt === 0) {
                    terminalPaymentStage = "cancelling";
                    terminalPaymentMessage = "Cancelling the payment on the Solo";
                    await terminateSumupCheckout().catch(() => undefined);
                    cancellationSentAt = Date.now();
                    deadline = Math.min(deadline, cancellationSentAt + 20_000);
                }

                const status = await getSumupTransactionStatus(clientTransactionId);
                const outcome = (status.simpleStatus || status.status).toUpperCase();
                if (outcome === "SUCCESSFUL" || outcome === "PAID_OUT") {
                    verifySumupApproval(status, reference, amount, config.currency);
                    const terminalReference = status.transactionCode || status.transactionId;
                    const loyaltyReference = bundle.payment.reference ? ` · ${bundle.payment.reference}` : "";
                    bundle.payment.reference = `SumUp ${terminalReference} [id:${status.transactionId}]${loyaltyReference}`;
                    approved = true;
                    terminalPaymentStage = "approved";
                    terminalPaymentMessage = "Card approved. Saving the sale";
                    await updateSumupAttempt(reference, "approved", {
                        clientTransactionId,
                        providerReference: `SumUp ${terminalReference} [id:${status.transactionId}]`,
                        saleBundle: bundle,
                    }).catch((error) => {
                        console.error("Could not update the approved SumUp recovery journal:", error);
                    });
                    return bundle;
                }
                if (["FAILED", "CANCELLED", "NON_COLLECTION"].includes(outcome)) {
                    const failedStatus = outcome === "CANCELLED" ? "cancelled" : "failed";
                    await updateSumupAttempt(reference, failedStatus, {
                        clientTransactionId,
                        error: `SumUp status: ${outcome}`,
                    });
                    finalized = true;
                    throw new Error(outcome === "CANCELLED" ? "The SumUp payment was cancelled" : "The card payment was not approved");
                }

                if (Date.now() >= nextReaderCheck) {
                    nextReaderCheck = Date.now() + 4_000;
                    let readerConfirmsCancellation = false;
                    try {
                        const reader = await getSumupReaderStatus();
                        if (reader.status === "OFFLINE") {
                            terminalPaymentMessage = "The Solo went offline. Waiting briefly for it to reconnect";
                        } else {
                            terminalPaymentMessage = sumupReaderMessage(reader.state);
                        }
                        if (
                            cancellationSentAt > 0
                            && reader.state === "IDLE"
                            && outcome === "NOT_FOUND"
                            && Date.now() - cancellationSentAt >= 4_000
                        ) {
                            readerConfirmsCancellation = true;
                        }
                    } catch {
                        // Transaction polling remains authoritative if reader telemetry is unavailable.
                    }
                    if (readerConfirmsCancellation) {
                        await updateSumupAttempt(reference, "cancelled", {
                            clientTransactionId,
                            error: "Cancelled by the operator before card approval",
                        });
                        finalized = true;
                        throw new Error("SumUp payment cancelled");
                    }
                }
                if (Date.now() >= nextLeaseRefresh) {
                    nextLeaseRefresh = Date.now() + 25_000;
                    if (!(await refreshSumupLock(config, tillId, reference))) {
                        await terminateSumupCheckout().catch(() => undefined);
                        throw new Error("This till lost the shared-reader reservation. Check SumUp before retrying.");
                    }
                }
                await delay(1_200);
            }

            await terminateSumupCheckout().catch(() => undefined);
            await updateSumupAttempt(reference, "uncertain", {
                clientTransactionId,
                error: "Timed out waiting for the terminal result",
            }).catch(() => undefined);
            throw new Error("SumUp did not return a final result in time. Check the Solo and SumUp transactions before retrying.");
        } catch (error) {
            if (!approved && !finalized) {
                const message = String(error);
                await updateSumupAttempt(reference, networkStarted ? "uncertain" : "cancelled", {
                    clientTransactionId,
                    error: message,
                }).catch(() => undefined);
            }
            throw error;
        } finally {
            if (lockHeld) {
                await releaseSumupLock(config, tillId, reference).catch((error) => {
                    console.warn("Could not release SumUp reader lock:", error);
                });
            }
        }
    }

    async function processManagedSumupRefund(
        config: SumupConfig,
        bundle: SaleBundle,
        originalOrderId: string,
        originalCardAmount: number,
        previouslyRefundedAmount: number,
        refundAmount: number,
        voiding: boolean,
    ): Promise<SaleBundle> {
        const reference = bundle.order.id;
        const attempt: SumupPaymentAttempt = {
            id: reference,
            provider: "sumup",
            terminalKey: sumupTerminalKey(config),
            clientTransactionId: "",
            terminalSessionId: "",
            operationKind: "refund",
            amount: refundAmount,
            expectedProviderAmount: previouslyRefundedAmount + refundAmount,
            currency: config.currency,
            status: "prepared",
            saleBundle: bundle,
            providerReference: "",
            error: "",
            tillId,
            createdAt: now(),
            updatedAt: now(),
        };
        bundle = requirePreparedSaleBundle(await saveSumupAttempt(attempt));

        let lockHeld = false;
        let approved = false;
        let networkStarted = false;
        let transactionId = "";
        try {
            const lockResult = await acquireSumupLock(config, tillId, tillName, reference);
            if (!lockResult.acquired) {
                const holder = lockResult.lock?.tillName || "another till";
                throw new Error(`The SumUp account is currently being used by ${holder}`);
            }
            lockHeld = true;

            const transaction = await getSumupTransactionByReference(originalOrderId);
            if (transaction.foreignTransactionId !== originalOrderId || !transaction.transactionId) {
                throw new Error("The original SumUp transaction could not be verified. No local refund was recorded.");
            }
            transactionId = transaction.transactionId;
            if (transaction.amount === undefined || Math.round(transaction.amount * 100) !== originalCardAmount) {
                throw new Error("The original SumUp amount does not match this sale. No refund was sent.");
            }
            if ((transaction.currency || "").toUpperCase() !== config.currency.toUpperCase()) {
                throw new Error("The original SumUp currency does not match this till. No refund was sent.");
            }
            if (transaction.refundedAmount === undefined) {
                throw new Error("SumUp did not return its refunded total. Check the SumUp transaction before retrying.");
            }
            const remoteRefunded = Math.round(transaction.refundedAmount * 100);
            if (remoteRefunded !== previouslyRefundedAmount) {
                throw new Error(
                    remoteRefunded > previouslyRefundedAmount
                        ? "SumUp already shows an additional refund. Sync the tills and review the transaction before retrying."
                        : "The POS refund history is ahead of SumUp. Review the transaction before retrying.",
                );
            }

            const terminalReference = transaction.transactionCode || transactionId;
            bundle.payment.reference = `${voiding ? "SumUp void" : "SumUp refund"} ${terminalReference} [id:${transactionId}]`;
            await updateSumupAttempt(reference, "started", {
                clientTransactionId: transactionId,
                providerReference: `${voiding ? "SumUp void" : "SumUp refund"} ${terminalReference} [id:${transactionId}]`,
                saleBundle: bundle,
            });

            await assertPaymentTerminalAttemptReady("sumup", reference);
            networkStarted = true;
            let requestError: unknown = null;
            try {
                await refundSumupTransaction(transactionId, refundAmount);
            } catch (error) {
                requestError = error;
            }
            let confirmedRefunded = -1;
            for (let check = 0; check < 6; check++) {
                const checked = await getSumupTransactionByReference(originalOrderId).catch(() => null);
                confirmedRefunded = checked?.refundedAmount === undefined
                    ? -1
                    : Math.round(checked.refundedAmount * 100);
                if (confirmedRefunded === previouslyRefundedAmount + refundAmount) break;
                await delay(700);
            }
            if (confirmedRefunded !== previouslyRefundedAmount + refundAmount) {
                throw new Error(`${requestError || "SumUp has not confirmed the refund"}. The refund result is uncertain; do not retry.`);
            }

            approved = true;
            await updateSumupAttempt(reference, "approved", {
                clientTransactionId: transactionId,
                providerReference: `${voiding ? "SumUp void" : "SumUp refund"} ${terminalReference} [id:${transactionId}]`,
                saleBundle: bundle,
            }).catch((error) => {
                console.error("Could not update the approved SumUp refund journal:", error);
            });
        } catch (error) {
            if (!approved) {
                await updateSumupAttempt(reference, networkStarted ? "uncertain" : "cancelled", {
                    clientTransactionId: transactionId,
                    error: String(error),
                    saleBundle: bundle,
                }).catch(() => undefined);
            }
            throw error;
        } finally {
            if (lockHeld) {
                await releaseSumupLock(config, tillId, reference).catch((error) => {
                    console.warn("Could not release SumUp refund lock:", error);
                });
            }
        }
        return bundle;
    }

    async function processManagedDojoRefund(
        config: DojoConfig,
        bundle: SaleBundle,
        paymentIntentId: string,
        originalCardAmount: number,
        previouslyRefundedAmount: number,
        refundAmount: number,
        voiding: boolean,
    ): Promise<SaleBundle> {
        const reference = bundle.order.id;
        const attempt: DojoPaymentAttempt = {
            id: reference,
            provider: "dojo",
            terminalKey: dojoTerminalKey(config),
            clientTransactionId: paymentIntentId,
            terminalSessionId: "",
            operationKind: "refund",
            amount: refundAmount,
            expectedProviderAmount: previouslyRefundedAmount + refundAmount,
            currency: config.currency,
            status: "prepared",
            saleBundle: bundle,
            providerReference: "",
            error: "",
            tillId,
            createdAt: now(),
            updatedAt: now(),
        };
        bundle = requirePreparedSaleBundle(await saveDojoAttempt(attempt));

        let lockHeld = false;
        let approved = false;
        let networkStarted = false;
        try {
            const lockResult = await acquireDojoLock(config, tillId, tillName, reference);
            if (!lockResult.acquired) {
                const holder = lockResult.lock?.tillName || "another till";
                throw new Error(`The Dojo account is currently being used by ${holder}`);
            }
            lockHeld = true;

            const paymentIntent = await getDojoPaymentIntentStatus(paymentIntentId);
            if (paymentIntent.id !== paymentIntentId || paymentIntent.reference !== bundle.order.originalOrderId) {
                throw new Error("The original Dojo payment could not be verified. No refund was sent.");
            }
            const originalBreakdown = getDojoPaymentBreakdown(paymentIntent, originalCardAmount, config.currency);
            if (voiding && (originalBreakdown.tipsAmount > 0 || originalBreakdown.serviceChargeAmount > 0 || originalBreakdown.cashbackAmount > 0)) {
                throw new Error("The Dojo payment includes tips, service charge or cashback. No void was sent. Use a goods-only refund and reconcile the additional amounts separately.");
            }
            if (paymentIntent.status !== "Captured") {
                throw new Error(`The original Dojo payment is ${paymentIntent.status}, not available for a goods refund. No refund was sent.`);
            }
            if (paymentIntent.refundedAmount === undefined) {
                throw new Error("Dojo did not return its refunded total. Check the Dojo portal before retrying.");
            }
            if (paymentIntent.refundedAmount !== previouslyRefundedAmount) {
                throw new Error(
                    paymentIntent.refundedAmount > previouslyRefundedAmount
                        ? "Dojo already shows an additional refund. Sync the tills and review the payment before retrying."
                        : "The POS refund history is ahead of Dojo. Review the payment before retrying.",
                );
            }

            const terminalReference = paymentIntent.transactionId || paymentIntentId;
            bundle.payment.reference = `${voiding ? "Dojo void" : "Dojo refund"} ${terminalReference} [id:${paymentIntentId}]`;
            await updateDojoAttempt(reference, "started", {
                clientTransactionId: paymentIntentId,
                providerReference: `${voiding ? "Dojo void" : "Dojo refund"} ${terminalReference} [id:${paymentIntentId}]`,
                saleBundle: bundle,
            });

            await assertPaymentTerminalAttemptReady("dojo", reference);
            networkStarted = true;
            let requestError: unknown = null;
            let refundRejected = false;
            try {
                const result = await refundDojoPaymentIntent(paymentIntentId, refundAmount, reference);
                refundRejected = result.paymentIntentId === paymentIntentId && result.rejected === true;
            } catch (error) {
                requestError = error;
            }

            let confirmed: DojoPaymentIntentStatus | null = null;
            for (let check = 0; check < 6; check++) {
                confirmed = await getDojoPaymentIntentStatus(paymentIntentId);
                if ((confirmed.refundedAmount ?? -1) >= previouslyRefundedAmount + refundAmount) break;
                await delay(500);
            }
            if (refundRejected && confirmed?.id === paymentIntentId
                && confirmed.reference === bundle.order.originalOrderId && confirmed.status === 'Captured'
                && confirmed.refundedAmount === previouslyRefundedAmount) {
                getDojoPaymentBreakdown(confirmed, originalCardAmount, config.currency);
                networkStarted = false; // Explicit rejection plus fresh, unchanged provider totals.
                throw new Error('Dojo declined the refund. No refund was recorded. Contact Dojo if this sandbox terminal does not support refunds.');
            }
            if ((confirmed?.refundedAmount ?? -1) !== previouslyRefundedAmount + refundAmount) {
                throw new Error(`${requestError || "Dojo has not confirmed the refund"}. The refund result is uncertain; do not retry.`);
            }
            if (!confirmed || confirmed.id !== paymentIntentId
                || confirmed.reference !== bundle.order.originalOrderId
                || !["Captured", "Refunded"].includes(confirmed.status)) {
                throw new Error("Dojo has not confirmed the expected refund identity and final status. Do not refund again; check Dojo.");
            }
            getDojoPaymentBreakdown(confirmed, originalCardAmount, config.currency);
            approved = true;
            await updateDojoAttempt(reference, "approved", {
                clientTransactionId: paymentIntentId,
                providerReference: `${voiding ? "Dojo void" : "Dojo refund"} ${terminalReference} [id:${paymentIntentId}]`,
                saleBundle: bundle,
            }).catch((error) => {
                console.error("Could not update the approved Dojo refund journal:", error);
            });
        } catch (error) {
            if (!approved) {
                await updateDojoAttempt(reference, networkStarted ? "uncertain" : "cancelled", {
                    clientTransactionId: paymentIntentId,
                    error: String(error),
                    saleBundle: bundle,
                }).catch(() => undefined);
            }
            throw error;
        } finally {
            if (lockHeld) {
                await releaseDojoLock(config, tillId, reference).catch((error) => {
                    console.warn("Could not release Dojo refund lock:", error);
                });
            }
        }
        return bundle;
    }

    async function cancelManagedTerminalPayment() {
        if (!isCompletingSale || terminalCancelRequested || terminalPaymentStage === "approved" || terminalPaymentStage === "saving") return;
        terminalCancelRequested = true;
        terminalPaymentStage = "cancelling";
        terminalPaymentMessage = `Cancelling the payment on the ${activeManagedProvider === "dojo" ? "Dojo terminal" : "Solo"}`;
    }

    async function recoverApprovedSumupSales() {
        if (recoveringSumupPayments) return;
        recoveringSumupPayments = true;
        try {
            const result = await runTerminalRecovery("sumup");
            if (result.completed > 0) {
                toast(`Recovered ${result.completed} SumUp terminal transaction${result.completed === 1 ? "" : "s"}`, "success");
            }
            if (result.stillUncertain > 0) {
                toast(`${result.stillUncertain} SumUp result${result.stillUncertain === 1 ? " is" : "s are"} still being reconciled. Do not retry the card.`, "error");
            }
        } finally {
            recoveringSumupPayments = false;
        }
    }

    async function recoverApprovedDojoSales() {
        if (recoveringDojoPayments) return;
        recoveringDojoPayments = true;
        try {
            const result = await runTerminalRecovery("dojo");
            for (const cashback of result.cashbackToReview) {
                toast(cashbackRecoveryMessage(cashback), "error", false, undefined, { persistent: true });
            }
            if (result.completed > 0) {
                toast(`Recovered ${result.completed} Dojo terminal transaction${result.completed === 1 ? "" : "s"}`, "success");
            }
            if (result.stillUncertain > 0) {
                toast(`${result.stillUncertain} Dojo result${result.stillUncertain === 1 ? " is" : "s are"} still being reconciled. Do not retry the card.`, "error");
            }
        } finally {
            recoveringDojoPayments = false;
        }
    }

    async function finishCheckoutExpiryReview() {
        const id = checkoutExpiryAttempt?.id;
        if (!id) return;
        try {
            const result = await runTerminalRecovery('dojo');
            const reviewed = await refreshPaymentTerminalAttempt('dojo', id);
            if (reviewed.status === 'completed') {
                const completed = requirePreparedSaleBundle(reviewed);
                applyCompletedSaleToStores(completed);
                cart = []; selectedCartIndex = 0; searchQuery = ''; notFoundBarcode = '';
                selectedCustomerId = ''; useLoyaltyCredit = false;
                const cashback = Number(completed.payment.cashbackAmount || 0);
                toast(cashback > 0 ? `Payment recorded. Check whether cashback ${formatMoney(cashback)} was already handed over before paying it out.` : 'Receipt-checked card payment recorded successfully.',
                    'success', true, () => printCompletedSaleReceipt(completed), { persistent: cashback > 0 });
            } else if (reviewed.status === 'cancelled' || reviewed.status === 'failed') {
                toast('Dojo confirmed cancellation. The trolley is ready for another payment.', 'info');
                showPaymentModal = true;
            } else {
                toast('The review is saved. Payment recovery is still pending; use Reports → Payment checks before taking another payment.', 'error');
            }
            for (const cashback of result.cashbackToReview) {
                if (cashback.attemptId !== id) toast(cashbackRecoveryMessage(cashback), 'error', false, undefined, { persistent: true });
            }
        } catch (error) { toast(`Payment review is saved; recovery needs checking: ${String(error)}`, 'error'); }
    }

    async function completeSale() {
        if (showNewPaymentCustomer || newPaymentCustomerSaving || loyaltyCreditBusy) return;
        if (isCompletingSale || refreshingSaleQuote) return;
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
        // Recheck at confirmation, before deciding tender or sending money to a
        // terminal. A delayed timer must not charge an expired offer.
        const displayedTotal = total;
        const displayedDue = paymentDue;
        refreshingSaleQuote = true;
        try {
            refreshPromotionClock();
            await tick();
        } catch (error) {
            toast(`Sale was not completed: ${error}`, 'error');
            return;
        } finally {
            refreshingSaleQuote = false;
        }
        if (!showPaymentModal || cart.length === 0) return;
        if (total !== displayedTotal || paymentDue !== displayedDue) {
            toast('The amount due changed. Please review the updated total and confirm again.', 'info');
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
        if (paymentMethod === "account") {
            if (!selectedCustomer || !selectedCustomerAccount?.isEnabled) {
                toast("Select a customer with Pay later enabled", "error");
                return;
            }
            if (!hasPermission($currentEmployee, "charge_customer_account", $settingsDB)) {
                toast("You do not have permission to charge customer accounts", "error");
                return;
            }
            if ($connectionState.mode === "multi" && !$connectionState.mysqlOnline) {
                toast("MariaDB must be online for Pay later", "error");
                return;
            }
            if (!accountLimitAllowsSale) {
                toast("This sale would exceed the customer's account limit", "error");
                return;
            }
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
        let approvedManagedBundle: SaleBundle | null = null;
        let approvedManagedProvider: "sumup" | "dojo" | null = null;
        try {
            const activeSumupConfig = get(sumupConfigStore);
            const activeDojoConfig = get(dojoConfigStore);

            // Determine split amounts
            let cashAmount = 0;
            let cardAmount = 0;
            let accountAmount = 0;
            let change = 0;
            let method: 'cash' | 'card' | 'split' | 'loyalty' | 'account' = paymentMethod;

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
            } else if (paymentMethod === "account") {
                accountAmount = paymentDue;
                cashAmount = 0;
                cardAmount = 0;
                change = 0;
            }
            if (loyaltyCreditUsed > 0 && paymentDue === 0) {
                method = 'loyalty';
                cashAmount = 0;
                cardAmount = 0;
                change = 0;
            }
            const usesManagedSumup = !trainingModeEnabled
                && paymentMethod === "card"
                && cardAmount > 0
                && activeManagedProvider === "sumup"
                && activeSumupConfig.enabled
                && activeSumupConfig.ready;
            const usesManagedDojo = !trainingModeEnabled
                && paymentMethod === "card"
                && cardAmount > 0
                && activeManagedProvider === "dojo"
                && activeDojoConfig.enabled
                && activeDojoConfig.ready;
            const basePaymentMethod = usesManagedDojo
                ? (method === 'split' ? 'split+dojo' : 'dojo')
                : usesManagedSumup
                    ? (method === 'split' ? 'split+sumup' : 'sumup')
                    : method;
            const recordedPaymentMethod = loyaltyCreditUsed > 0 && method !== 'loyalty'
                ? `${basePaymentMethod}+loyalty`
                : basePaymentMethod;

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
                const product = $productById.get(item.id);
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
            loyaltyAmount: loyaltyCreditUsed,
            accountAmount,
            reference: accountAmount > 0
                ? `Pay later · ${selectedCustomer?.name || "Customer"}`
                : loyaltyCreditUsed > 0 ? `Loyalty value ${formatMoney(loyaltyCreditUsed)}` : "",
            changeGiven: paymentMethod === "cash" ? Math.max(0, change) : 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            };
            const stockChanges = stockTrackingEnabled ? cart.flatMap((item) => {
                const product = $productById.get(item.id);
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
                newData: JSON.stringify({
                    total,
                    paymentMethod: recordedPaymentMethod,
                    tillNumber: tillId,
                    itemLines: cart.length,
                    itemQuantity: cart.reduce((sum, item) => sum + item.quantity, 0),
                    customerId: selectedCustomerId,
                    customerName: selectedCustomer?.name || "",
                    loyaltyCreditUsed,
                    loyaltyPointsRedeemed,
                    loyaltyPointsEarned,
                    cashAmount,
                    cardAmount,
                    accountAmount,
                    changeGiven: paymentMethod === "cash" ? Math.max(0, change) : 0,
                }),
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

            const accountChanges = accountAmount > 0 && selectedCustomer && selectedCustomerAccount ? [{
                id: uuid(),
                accountId: selectedCustomerAccount.id,
                customerId: selectedCustomer.id,
                orderId,
                entryType: 'charge' as const,
                amountPence: accountAmount,
                paymentMethod: '' as const,
                reference: '',
                description: `Pay later sale for ${selectedCustomer.name}`,
                receiptNumber: 0,
                receiptKey: '',
                employeeId: newOrder.employeeId,
                tillNumber: tillId,
                shiftId: $currentShiftId,
                idempotencyKey: `sale-account:${orderId}`,
                reversesEntryId: '',
                balanceAfterPence: 0,
                createdAt: timestamp,
                updatedAt: timestamp,
            }] : [];

            let saleBundle: SaleBundle = {
                order: newOrder,
                lines,
                payment,
                stockChanges,
                loyaltyChanges,
                accountChanges,
                audit,
            };

            if (trainingModeEnabled) {
                cart = [];
                selectedCartIndex = 0;
                searchQuery = "";
                notFoundBarcode = "";
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
                toast("Training sale completed. Nothing was saved.", "success", false, undefined,
                    { dismissOnScan: true, ...(paymentMethod === 'cash' ? { cashChangePence: change } : {}) });
                return;
            }

            // The accepted price, tender and receipt lines are now captured in
            // saleBundle. Do not rebuild them after asynchronous preparation.
            if (isTauri()) await ensureTillReceiptSequence();

            if (activeHeldRecovery && isTauri()) {
                // Record the receipt identity before ANY payment work. Recovery
                // checks these identities to avoid restoring an already paid cart.
                activeHeldRecovery = { ...activeHeldRecovery, cart, customerId: selectedCustomerId,
                    discountId: selectedManualDiscountId, saleIds: [...activeHeldRecovery.saleIds, orderId] };
                await persistHeldRecovery(activeHeldRecovery);
                if (heldRecoveryWriteError) throw new Error(heldRecoveryWriteError);
            }

            if (!isTauri()) {
                const previewCustomerName = selectedCustomer?.name || 'Customer';
                const committedPreview = await commitSale(saleBundle);
                const previewBalance = committedPreview.accountChanges?.at(-1)?.balanceAfterPence;
                await refreshLatestTillReceipt();
                cart = [];
                selectedCartIndex = 0;
                searchQuery = "";
                notFoundBarcode = "";
                showPaymentModal = false;
                customerDisplayChange = paymentMethod === "cash" ? Math.max(0, change) : 0;
                customerDisplayCompleteUntil = Date.now() + 8000;
                setTimeout(() => {
                    customerDisplayCompleteUntil = 0;
                    customerDisplayChange = 0;
                }, 8000);
                customerAccountLoadToken += 1;
                selectedCustomerId = "";
                selectedCustomerAccount = null;
                customerAccountBusy = false;
                useLoyaltyCredit = false;
                playSuccessSound();
                toast(
                    accountAmount > 0
                        ? `Preview sale charged to ${previewCustomerName}. Now owes ${formatMoney(previewBalance ?? accountBalanceAfterSale)}.`
                        : "Preview sale completed and added to the browser report.",
                    "success",
                    false,
                    undefined,
                    { dismissOnScan: true, ...(paymentMethod === 'cash' ? { cashChangePence: change } : {}) },
                );
                return;
            }

            if (usesManagedSumup || usesManagedDojo) {
                await requireManualSaleAccess();
            }

            if (usesManagedSumup) {
                saleBundle = await processManagedSumupPayment(activeSumupConfig, saleBundle, cardAmount);
                approvedManagedBundle = saleBundle;
                approvedManagedProvider = "sumup";
                terminalPaymentStage = "saving";
                terminalPaymentMessage = "Card approved. Saving the sale";
            } else if (usesManagedDojo) {
                saleBundle = await processManagedDojoPayment(activeDojoConfig, saleBundle, cardAmount);
                approvedManagedBundle = saleBundle;
                approvedManagedProvider = "dojo";
                terminalPaymentStage = "saving";
                terminalPaymentMessage = "Card approved. Saving the sale";
            }

            const committedSale = await commitSale(saleBundle);
            const completedAccountCustomerName = selectedCustomer?.name || 'Customer';
            if (approvedManagedBundle && approvedManagedProvider) {
                if (approvedManagedProvider === "dojo") {
                    await updateDojoAttempt(approvedManagedBundle.order.id, "completed", { saleBundle: committedSale });
                } else {
                    await updateSumupAttempt(approvedManagedBundle.order.id, "completed", { saleBundle: committedSale });
                }
                approvedManagedBundle = null;
                approvedManagedProvider = null;
            }
            applyCompletedSaleToStores(committedSale);
            const cashbackToGive = Number(committedSale.payment.cashbackAmount || 0);
            void openDrawerAfterSuccessfulPayment(cashAmount + cashbackToGive);
            void printReceiptAfterSuccessfulPayment(committedSale);
            sendCompletedBundleToCctv(committedSale);

            cart = [];
            selectedCartIndex = 0;
            searchQuery = "";
            notFoundBarcode = "";
            showPaymentModal = false;
            customerDisplayChange = paymentMethod === "cash" ? Math.max(0, change) : 0;
            customerDisplayCompleteUntil = Date.now() + 8000;
            setTimeout(() => {
                customerDisplayCompleteUntil = 0;
                customerDisplayChange = 0;
            }, 8000);
            customerAccountLoadToken += 1;
            selectedCustomerId = "";
            selectedCustomerAccount = null;
            customerAccountBusy = false;
            useLoyaltyCredit = false;
            playSuccessSound();
            toast(
                paymentMethod === "account"
                    ? `Sale completed. ${formatMoney(accountAmount)} charged to ${completedAccountCustomerName}.`
                    : paymentMethod === "cash"
                    ? 'Cash payment saved successfully.'
                    : cashbackToGive > 0
                        ? `Give cashback ${formatMoney(cashbackToGive)}. This is cashback, not change. Sale completed successfully.`
                        : "Sale completed successfully",
                "success",
                true,
                () => printCompletedSaleReceipt(committedSale),
                { dismissOnScan: cashbackToGive === 0, persistent: cashbackToGive > 0,
                    ...(paymentMethod === 'cash' ? { cashChangePence: change } : {}) },
            );
            void triggerSync();
        } catch (e) {
            console.error(e);
            if (approvedManagedBundle && approvedManagedProvider) {
                const updateAttempt = approvedManagedProvider === "dojo" ? updateDojoAttempt : updateSumupAttempt;
                await updateAttempt(approvedManagedBundle.order.id, "commit_failed", {
                    error: String(e),
                    saleBundle: approvedManagedBundle,
                }).catch(() => undefined);
                cart = [];
                selectedCartIndex = 0;
                searchQuery = "";
                notFoundBarcode = "";
                showPaymentModal = false;
                selectedCustomerId = "";
                useLoyaltyCredit = false;
                toast("Card approved. The sale is safely queued and will save automatically when the database is ready. Do not charge it again.", "error");
                setTimeout(() => void (approvedManagedProvider === "dojo" ? recoverApprovedDojoSales() : recoverApprovedSumupSales()), 2_000);
            } else if (!showCheckoutExpiryReview) {
                toast(`Sale was not completed: ${e}`, "error");
            }
        } finally {
            isCompletingSale = false;
            refreshPromotionClock();
            terminalCancelRequested = false;
            terminalPaymentStage = "idle";
            terminalPaymentMessage = "";
        }
    }
</script>

<svelte:window
    on:keydown={handleModalKeydown}
    on:pointerdown={handleModalBackdropPointerDown}
/>

{#if !$currentEmployee && $employeesDB.length > 0}
    <div
        use:modalFocusTrap={{
            dismiss: dismissLoginDialog,
            dismissDisabled: loginBusy || (!showSupportAccess && !selectedLoginEmployee),
        }}
        class="login-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby={showSupportAccess ? "support-access-title" : "staff-sign-in-title"}
        tabindex="-1"
        bind:this={loginDialog}
    >
        <form class="login-form" class:login-form-picker={!selectedLoginEmployee && !showSupportAccess} aria-busy={loginBusy} on:submit|preventDefault={() => !showSupportAccess && login()}>
            <div class="login-brand-row">
                <span class="login-brand-mark"><img src="/lbj-pos-logo.png" alt="" /></span>
                <span class="login-brand-copy">
                    <strong>{$storeDB.name}</strong>
                    <small>{$deviceOperatingMode === 'back_office' ? deviceOperatingModeLabel($deviceOperatingMode) : tillName}</small>
                </span>
                <span class="login-brand-actions">
                    <button
                        type="button"
                        class="login-fullscreen-button"
                        disabled={loginFullscreenBusy}
                        aria-label={loginFullscreen ? "Exit full screen" : "Enter full screen"}
                        aria-pressed={loginFullscreen}
                        title={loginFullscreen ? "Exit full screen" : "Enter full screen"}
                        on:click={toggleLoginFullscreen}
                    >
                        {#if loginFullscreen}
                            <Minimize2 size={20} strokeWidth={2.35} aria-hidden="true" />
                        {:else}
                            <Maximize2 size={20} strokeWidth={2.35} aria-hidden="true" />
                        {/if}
                    </button>
                    <LockKeyhole class="login-lock-icon" size={22} aria-hidden="true" />
                </span>
            </div>
            {#if showSupportAccess}
                <SupportAccessPanel onClose={() => (showSupportAccess = false)} onActivate={activateSupportSession} />
            {:else}
                <div class="login-heading">
                    <h1 id="staff-sign-in-title">{$deviceOperatingMode === 'back_office' ? 'Back Office Sign In' : 'Staff Sign In'}</h1>
                    <p>{selectedLoginEmployee
                        ? `Enter the PIN for ${selectedLoginEmployee.name}.`
                        : $deviceOperatingMode === 'back_office'
                            ? 'Choose your user to open Back Office.'
                            : 'Choose your user to open this till.'}</p>
                </div>
                {#if !selectedLoginEmployee}
                    {#if activeLoginEmployees.length > 0}
                        <div class="login-staff-list" aria-label="Active staff">
                            {#each activeLoginEmployees as employee}
                                <button
                                    type="button"
                                    class="login-staff-button"
                                    on:click={() => chooseLoginEmployee(employee.id)}
                                >
                                    <span class="login-staff-avatar" aria-hidden="true">{employeeInitials(employee.name)}</span>
                                    <span class="login-staff-copy">
                                        <strong>{employee.name}</strong>
                                        <small>{roleLabels[employee.role]}</small>
                                    </span>
                                    <ChevronRight size={20} aria-hidden="true" />
                                </button>
                            {/each}
                        </div>
                    {:else}
                        <div class="login-empty-state">
                            <strong class="block text-danger">{$deviceOperatingMode === 'back_office' ? 'No staff with Back Office access' : 'No active staff accounts'}</strong>
                            <p class="text-sm text-text-muted my-3">{$deviceOperatingMode === 'back_office' ? 'An administrator must grant a management permission before this staff member can sign in here.' : 'All staff accounts are deactivated. Open setup to recover access.'}</p>
                            <button type="button" class="btn btn-primary" on:click={() => goto('/setup')}>Open Setup</button>
                        </div>
                    {/if}
                    <button type="button" class="login-support-button" on:click={openSupportAccess}>
                        <span class="login-support-icon" aria-hidden="true"><ShieldCheck size={22} strokeWidth={2.3} /></span>
                        <span><strong>L&amp;Bj Support</strong><small>Use a temporary signed support code</small></span>
                        <ChevronRight size={20} aria-hidden="true" />
                    </button>
                {:else}
                    <div class="login-pin-layout" class:back-office={$deviceOperatingMode === 'back_office'}>
                        <section class="login-person">
                            <span class="login-person-avatar" aria-hidden="true">{employeeInitials(selectedLoginEmployee.name)}</span>
                            <span class="login-person-label">Signing in as</span>
                            <strong>{selectedLoginEmployee.name}</strong>
                            <small>{roleLabels[selectedLoginEmployee.role]}</small>
                            <p>Enter your 4 to 8 digit PIN.</p>
                            <p class="login-error" class:visible={Boolean(loginError)} aria-live="polite">{loginError || "\u00A0"}</p>
                            <button type="button" class="btn btn-secondary login-change-user" disabled={loginBusy} on:click={() => chooseLoginEmployee("")}>
                                <UsersRound size={18} aria-hidden="true" />
                                Change user
                            </button>
                        </section>
                        {#if $deviceOperatingMode === 'back_office'}
                            <section class="login-desktop-pin" aria-label="PIN sign in">
                                <span class="login-desktop-pin-icon" aria-hidden="true"><LockKeyhole size={24} strokeWidth={2.25} /></span>
                                <div>
                                    <label for="back-office-login-pin">Staff PIN</label>
                                    <p>Use your keyboard to enter your PIN.</p>
                                </div>
                                <input
                                    id="back-office-login-pin"
                                    class="login-desktop-pin-input"
                                    bind:this={loginPinInput}
                                    value={loginPin}
                                    type="password"
                                    autocomplete="off"
                                    maxlength="8"
                                    pattern={"[0-9]{4,8}"}
                                    placeholder="4 to 8 digits"
                                    disabled={loginBusy}
                                    data-touch-keyboard="off"
                                    on:input={handleDesktopLoginPinInput}
                                    on:keydown={handleDesktopLoginPinKeydown}
                                />
                                <button
                                    type="submit"
                                    class="btn btn-primary login-desktop-submit"
                                    disabled={loginPin.length < 4 || loginBusy}
                                >
                                    {loginBusy ? 'Signing In…' : 'Sign In'}
                                </button>
                                <small>Press Enter to sign in · Esc to change user</small>
                            </section>
                        {:else}
                            <TouchDigitPad
                                bind:value={loginPin}
                                masked={true}
                                maxLength={8}
                                placeholder="Enter PIN"
                                submitLabel={loginBusy ? "Signing In..." : "Sign In"}
                                submitDisabled={loginPin.length < 4 || loginBusy}
                                disabled={loginBusy}
                                onSubmit={login}
                            />
                        {/if}
                    </div>
                {/if}
            {/if}
        </form>
    </div>
{/if}

{#if restoringRememberedSession}
    <div class="fixed inset-0 z-[1050] bg-bg-base/90 flex items-center justify-center p-4">
        <div
            use:modalFocusTrap={{ dismissDisabled: true }}
            class="bg-bg-card border border-border-flat rounded-md px-5 py-4 shadow-[var(--shadow)] text-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restoring-session-dialog-title"
            aria-describedby="restoring-session-dialog-description"
        >
            <strong id="restoring-session-dialog-title" class="block text-text-main">Reopening staff session</strong>
            <span id="restoring-session-dialog-description" class="block text-sm text-text-muted mt-1">Checking the till shift...</span>
        </div>
    </div>
{/if}

{#if pendingShiftEmployee}
    <div class="fixed inset-0 z-[1100] bg-bg-base flex items-center justify-center p-3 md:p-5">
        <div
            use:modalFocusTrap={{ dismiss: cancelOpeningShift, dismissDisabled: openingShiftBusy }}
            class="w-full max-w-[520px] max-h-[96vh] overflow-y-auto bg-bg-card border border-border-flat rounded-md p-5 md:p-7 flex flex-col gap-4 shadow-[var(--shadow)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="opening-shift-dialog-title"
        >
            <div>
                <h1 id="opening-shift-dialog-title" class="text-2xl font-bold">Open Till Shift</h1>
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
                submitLabel={openingShiftBusy ? "Opening Shift..." : "Open Shift"}
                submitDisabled={openingShiftBusy}
                disabled={openingShiftBusy}
                onSubmit={openShiftWithFloat}
            />
            <button type="button" class="btn btn-secondary" disabled={openingShiftBusy} on:click={cancelOpeningShift}>Cancel and Sign Out</button>
        </div>
    </div>
{/if}

{#if attendanceEnabled}
<AttendanceClock
    bind:show={attendanceClockOpen}
    staffSignIn={true}
    allowHistoryNavigation={false}
/>
{/if}

<div
    class="pos-checkout-shell flex h-screen w-screen overflow-hidden"
    class:device-back-office-shell-hidden={$deviceOperatingMode === 'back_office'}
    inert={!$currentEmployee || $currentEmployee?.role === 'attendance' || $deviceOperatingMode === 'back_office' || restoringRememberedSession || Boolean(pendingShiftEmployee)}
    aria-hidden={!$currentEmployee || $currentEmployee?.role === 'attendance' || $deviceOperatingMode === 'back_office' || restoringRememberedSession || Boolean(pendingShiftEmployee)}
>
    <!-- Main Content (Products) -->
    <main class="pos-products flex-1 flex flex-col p-2 md:p-3 lg:p-5 overflow-hidden">
        <header
            class="pos-main-header grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-3 h-12 md:h-14 lg:h-16 mb-2 md:mb-3 lg:mb-5 shrink-0"
        >
            <div class="flex min-w-0 items-center gap-4">
                <div>
                    <button
                        class="pos-admin-button h-12 min-w-[104px] rounded-md bg-bg-card border border-border-flat px-3 flex items-center justify-center gap-2 font-black text-text-main hover:bg-bg-card-hover hover:border-accent-primary transition-colors {isMenuDisabled ? 'opacity-70' : ''}"
                        aria-disabled={isMenuDisabled}
                        aria-label="Open Admin"
                        title="Open Admin"
                        on:click|stopPropagation={() => handleMenuClick("/admin")}
                    >
                        <img class="pos-admin-logo" src="/lbj-pos-logo.png" alt="" />
                        <span>Admin</span>
                    </button>
                </div>

                <button
                    class="pos-user-button flex items-center gap-3 bg-transparent hover:bg-bg-card rounded-md p-1.5 transition-colors"
                    title="Change user"
                    aria-label={`Change user: ${$currentEmployee?.name || 'Signed out'}`}
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

            <div class="pos-shop-identity">
                <h1
                    class="min-w-0 truncate text-center text-xl md:text-2xl lg:text-3xl font-black text-text-main tracking-tight"
                    title={$storeDB.name}
                >
                    {$storeDB.name}
                </h1>
                <span class="pos-till-chip" title={tillName || tillId}>
                    <small>Till</small>
                    <b>{tillName || tillId}</b>
                </span>
            </div>
            <div class="pos-header-status justify-self-end">
                <ConnectionStatusPill />
                {#if attendanceEnabled}
                <button
                    type="button"
                    class="pos-clock attendance-clock-trigger"
                    title="Staff attendance · sign in to clock in or out"
                    aria-label={`Staff attendance. ${headerTime}`}
                    on:click={() => (attendanceClockOpen = true)}
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <circle cx="12" cy="12" r="9"></circle>
                        <path d="M12 7v5l3 2"></path>
                    </svg>
                    {headerTime}
                </button>
                {:else}
                    <time class="pos-clock" aria-label={`Current time: ${headerTime}`}>{headerTime}</time>
                {/if}
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
                    class="pos-page-tab whitespace-nowrap px-6 py-3 rounded-sm font-semibold text-sm transition-colors {activePageId ===
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

        <!-- Product slots reflow on narrow displays while retaining their order. -->
        <div class="pos-product-workspace flex flex-col gap-2 md:gap-3 lg:gap-5 flex-1 min-h-0">
            <div class="pos-product-grid grid grid-cols-4 grid-rows-4 gap-1 md:gap-2 lg:gap-3 flex-1 min-h-0">
                {#each displayTiles as slot, tileIndex (`${currentPageIndex}:${tileIndex}:${slot?.tile.id || "empty"}:${slot?.product?.updatedAt || ""}:${slot?.product?.price ?? ""}`)}
                    {#if slot && slot.product}
                        {@const temporaryOffer = activeTemporaryOffer(slot.product.id, slot.product.price, promoClock)}
                        <button
                            type="button"
                            class="pos-product-tile relative h-full min-h-0 overflow-hidden cursor-pointer bg-[var(--tile-bg)] border border-border-flat rounded-md transition-colors hover:brightness-110 flex flex-col"
                            aria-label={`Add ${slot.product.name}, ${formatMoney(temporaryOffer?.price ?? slot.product.price)}`}
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
                                        class="absolute inset-0 h-full w-full bg-white object-contain"
                                    />
                                {/if}
                                <div
                                    class="pos-tile-text-backdrop absolute bottom-0 left-0 right-0 p-2"
                                >
                                    <div class="pos-tile-caption flex items-end justify-between gap-2">
                                        <h3
                                            class="pos-tile-name m-0 text-white line-clamp-3"
                                        >
                                            {slot.product.name}
                                        </h3>
                                        <span
                                            class="pos-tile-price bg-[var(--price-bg)] px-2 py-1 rounded-sm text-[var(--price-text)] shrink-0"
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
                        </button>
                    {:else}
                        <div
                            class="bg-bg-card/30 border border-border-flat/30 border-dashed rounded-md"
                        ></div>
                    {/if}
                {/each}
            </div>
            <div class="pos-toolbar flex items-center gap-1.5 md:gap-2 h-14 md:h-16 shrink-0">
                <button
                    class="pos-drawer-button h-full min-w-11 md:min-w-14 px-3 flex items-center justify-center gap-2 bg-bg-card border border-border-flat text-accent-primary rounded-md hover:bg-accent-primary hover:text-white transition-colors shrink-0 disabled:opacity-45 disabled:cursor-wait"
                    title="Open cash drawer"
                    disabled={drawerBusy}
                    on:click={() => handleOpenCashDrawer()}
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
                        class="pos-page-nav-button w-11 h-full md:w-14 flex items-center justify-center bg-bg-card border border-border-flat rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-bg-card-hover transition-colors text-sm font-bold"
                        disabled={currentPageIndex === 0}
                        on:click={() => currentPageIndex--}>&larr;</button
                    >
                    <span class="pos-page-position text-xs md:text-sm font-semibold text-text-muted w-11 h-full md:w-14 flex items-center justify-center leading-none"
                        >{currentPageIndex + 1}<span class="text-text-muted/50">/</span>{totalPages}</span
                    >
                    <button
                        class="pos-page-nav-button w-11 h-full md:w-14 flex items-center justify-center bg-bg-card border border-border-flat rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-bg-card-hover transition-colors text-sm font-bold"
                        disabled={currentPageIndex >= totalPages - 1}
                        on:click={() => currentPageIndex++}>&rarr;</button
                    >
                {/if}
                <div class="pos-toolbar-actions" style="--pos-toolbar-count: {toolbarLayout.length}">
                    {#each toolbarLayout as btn}
                        {#if btn === 'scale'}
                            <button class="pos-toolbar-action" on:click={openScale}>SCALE</button>
                        {:else if btn === 'label_print'}
                            <button
                                class="pos-toolbar-action"
                                disabled={cart.length > 0}
                                title={cart.length > 0 ? 'Complete, hold, or clear the trolley before printing labels' : 'Print product labels'}
                                on:click={() => goto('/label-print')}>LABEL PRINT</button>
                        {:else if btn === 'discount'}
                            <button class="pos-toolbar-action" on:click={openDiscounts}>DISCOUNT</button>
                        {:else if btn === 'goods'}
                            <button class="pos-toolbar-action" on:click={openGoodsModal}>GOODS</button>
                        {:else if btn === 'recent_trans'}
                            <button
                                class="pos-toolbar-action"
                                disabled={cart.length > 0}
                                title={cart.length > 0 ? 'Complete, hold, or clear the trolley before opening recent transactions' : 'Open recent transactions'}
                                on:click={openRecentTransactions}>RECENT TRANS</button>
                        {:else if btn === 'change_price'}
                            <button
                                class="pos-toolbar-action disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-card"
                                disabled={!hasSelectedCartItem}
                                on:click={openChangePrice}>CHANGE PRICE</button>
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
        <!-- Compact trolley header (retrieve + search + clear) -->
        <div
            class="pos-cart-header flex items-center gap-2 md:gap-3 p-3 md:p-4 border-b border-border-flat bg-bg-panel shrink-0"
        >
            <button
                class="pos-retrieve-button"
                class:has-orders={heldOrdersForTill.length > 0}
                class:has-shared-orders={otherTillHeldOrderCount > 0}
                disabled={heldOrdersLoading}
                title={`Retrieve held trolleys: ${ownHeldOrderCount} this till, ${otherTillHeldOrderCount} other tills`}
                aria-label={`Retrieve held trolleys: ${heldOrdersForTill.length} total`}
                on:click|stopPropagation={openHeldOrders}
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    width="17"
                    aria-hidden="true"
                >
                    <path d="M3 12a9 9 0 1 0 3-6.7"></path>
                    <path d="M3 4v6h6"></path>
                </svg>
                <span>Retrieve</span>
                <b>{heldOrdersLoading ? '...' : heldOrdersForTill.length}</b>
            </button>

            <div
                class="pos-scan-search flex-1 flex items-center gap-2 bg-bg-card border border-border-flat rounded-md px-3 h-10 focus-within:border-accent-primary transition-colors {showNotFoundModal ? 'opacity-40 pointer-events-none' : ''}"
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
                    placeholder="Scan barcode..."
                    aria-label="Scan product barcode"
                    class="bg-transparent border-none outline-none text-sm text-text-main w-full disabled:opacity-40"
                    bind:value={searchQuery}
                    on:keydown={handleSearchKeydown}
                    disabled={scannerOverlayOpen}
                    data-touch-keyboard="off"
                />
            </div>

            <button
                class="pos-cart-clear-button w-10 h-10 flex items-center justify-center bg-bg-card border border-border-flat text-danger rounded-md hover:bg-danger hover:text-white transition-colors shrink-0 disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-bg-card disabled:hover:text-danger"
                title="Clear Order"
                disabled={cart.length === 0}
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
                    role="status"
                    aria-live="polite"
                    class="trolley-inline-status pointer-events-none shrink-0 p-2 rounded-md text-xs font-semibold text-center {trolleyMessageType ===
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
                    class="cart-line flex items-center gap-1.5 p-1 md:p-1.5 rounded-md border transition-all group {selectedCartIndex === i ? 'cart-line-selected' : 'cart-line-normal'} {promoNotice?.kind === 'applied' ? 'cart-line-promo-applied' : promoNotice?.kind === 'eligible' ? 'cart-line-promo-eligible' : ''}"
                    class:cart-line-scale={scaleDisplay.kind !== 'each'}
                >
                    <button
                        type="button"
                        class="cart-line-select flex flex-1 min-w-0 items-center gap-1.5"
                        aria-label={`Select ${item.name}`}
                        aria-pressed={selectedCartIndex === i}
                        on:click={() => (selectedCartIndex = i)}
                    >
                        <div
                            class="cart-line-quantity text-[11px] md:text-xs font-bold text-accent-primary min-w-[18px] md:min-w-[22px] pt-0.5"
                        >
                            {scaleDisplay.kind === 'price' ? 'Label' : scaleDisplay.label}
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
                            {#if item.quantityLocked && scaleDisplay.kind === 'each'}
                                <span class="text-[9px] md:text-[10px] font-bold uppercase tracking-wide text-warning">Scale label · fixed quantity</span>
                            {/if}
                            {#if item.note && scaleDisplay.kind === 'each'}
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
                                    {scaleDisplay.kind === 'price' ? 'Label total' : formatMoney(item.price)}
                                </div>
                                <div class="text-[12px] md:text-[13px] font-black text-text-main leading-tight mt-0.5 truncate">
                                    {formatMoney(lineGross)}
                                </div>
                            {/if}
                        </div>
                    </button>
                    <button
                        class="w-6 h-6 flex items-center justify-center text-text-muted hover:text-danger opacity-60 group-hover:opacity-100 transition-all shrink-0"
                        aria-label={`Remove ${item.name} from trolley`}
                        title={`Remove ${item.name}`}
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
            <div class="pos-quantity-stepper flex-[3] min-w-0 h-8 md:h-10 lg:h-12 grid grid-cols-[1fr_minmax(34px,0.8fr)_1fr] overflow-hidden rounded-md border border-border-flat bg-bg-card">
                <button
                    disabled={!hasSelectedCartItem || selectedCartItem?.quantityLocked}
                    title={selectedCartItem?.quantityLocked ? "Scale-label quantity cannot be changed" : "Increase quantity"}
                    aria-label="Increase selected item quantity"
                    class="pos-touch-button flex min-w-0 items-center justify-center border-r border-border-flat text-base md:text-lg lg:text-xl font-bold hover:bg-bg-card-hover transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                    on:click={increaseQty}>+</button
                >
                <output
                    class="flex min-w-0 items-center justify-center bg-bg-panel px-1 text-sm md:text-base lg:text-lg font-black tabular-nums text-text-main"
                    aria-label="Selected item quantity"
                    aria-live="polite"
                >{selectedCartItem?.quantity ?? 0}</output>
                <button
                    disabled={!hasSelectedCartItem || selectedCartItem?.quantityLocked || selectedCartItem.quantity <= 1}
                    title={selectedCartItem?.quantityLocked ? "Scale-label quantity cannot be changed" : "Decrease quantity"}
                    aria-label="Decrease selected item quantity"
                    class="pos-touch-button flex min-w-0 items-center justify-center border-l border-border-flat text-base md:text-lg lg:text-xl font-bold hover:bg-bg-card-hover transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                    on:click={decreaseQty}>−</button
                >
            </div>
            <button
                disabled={selectedCartIndex <= 0}
                aria-label="Select previous trolley item"
                title="Select previous trolley item"
                class="pos-touch-button flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md hover:bg-bg-card-hover transition-colors text-text-main disabled:opacity-35 disabled:cursor-not-allowed"
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
                aria-label="Select next trolley item"
                title="Select next trolley item"
                class="pos-touch-button flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md hover:bg-bg-card-hover transition-colors text-text-main disabled:opacity-35 disabled:cursor-not-allowed"
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
                class="pos-touch-button pos-danger-button flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md text-danger hover:bg-danger hover:text-white transition-colors disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-bg-card disabled:hover:text-danger"
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
                class="pos-touch-button flex-[2] h-8 md:h-10 lg:h-12 flex items-center justify-center gap-1 md:gap-2 bg-bg-card border border-border-flat rounded-md font-bold text-[10px] md:text-sm hover:bg-bg-card-hover transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
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
                <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span
                        class="text-lg md:text-xl font-bold text-text-muted uppercase tracking-wider"
                        >Total</span
                    >
                    <CartDiscountSummary
                        lines={cartEval.lines}
                        {formatMoney}
                        bind:showDetails={showAppliedDiscounts}
                        eligibilityHint={selectedPromotionNotice?.kind === "eligible" ? selectedPromotionNotice.detail : ""}
                        eligibilityTitle={selectedPromotionNotice?.kind === "eligible" ? selectedPromotionNotice.title : ""}
                    />
                    {#if cartEval.optimizationLimited}
                        <span class="text-xs text-amber-700" role="status">Complex offers: review the best price</span>
                    {/if}
                    {#if heldRecoveryWriteError}<span class="text-xs text-red-700" role="alert">{heldRecoveryWriteError}</span>{/if}
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
                        class="pos-cart-action payment-action row-span-2 h-full bg-success text-white text-base md:text-lg font-black rounded-md shadow-lg hover:brightness-110 active:scale-[0.98] transition-all tracking-wider flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100"
                        disabled={cart.length === 0}
                        on:click={openPayment}>PAYMENT</button
                    >
                {:else if btn === 'goods'}
                    <button
                        class="pos-cart-action h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        on:click={openGoodsModal}>GOODS</button
                    >
                {:else if btn === 'last_receipt'}
                    <button
                        class="pos-cart-action h-full bg-bg-card border border-border-flat rounded-md text-[10px] font-bold leading-tight hover:bg-bg-card-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={lastReceiptPrinting || !latestTillReceiptOrder}
                        on:click={printLastTillReceipt}>{lastReceiptPrinting ? 'PRINTING...' : 'LAST RECEIPT'}</button
                    >
                {:else if btn === 'change_price'}
                    <button
                        class="pos-cart-action h-full bg-bg-card border border-border-flat rounded-md font-bold text-xs hover:bg-bg-card-hover transition-colors leading-tight disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-card"
                        disabled={!hasSelectedCartItem}
                        on:click={openChangePrice}>CHANGE PRICE</button
                    >
                {:else if btn === 'hold'}
                    <button
                        class="pos-cart-action h-full bg-bg-card border border-border-flat rounded-md text-[10px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={cart.length === 0 || isHoldingOrder}
                        on:click={holdOrder}>{isHoldingOrder ? 'HOLDING...' : 'HOLD'}</button
                    >
                {:else if btn === 'scale'}
                    <button
                        class="pos-cart-action h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        on:click={openScale}>SCALE</button
                    >
                {:else if btn === 'discount'}
                    <button
                        class="pos-cart-action h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        on:click={openDiscounts}>DISCOUNT</button
                    >
                {/if}
            {/each}
        </div>
    </aside>
</div>

{#if showDiscountModal}
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: () => (showDiscountModal = false) }}
            class="flat-panel modal-box"
            role="dialog"
            aria-modal="true"
            aria-labelledby="discount-dialog-title"
        >
            <div class="modal-header">
                <div>
                    <h3 id="discount-dialog-title">Apply Discount</h3>
                    <p class="m-0 text-sm text-text-muted">Choose one manual percentage discount for this sale.</p>
                </div>
                <button class="modal-close" aria-label="Close discount dialog" on:click={() => (showDiscountModal = false)}>✕</button>
            </div>
            <div class="modal-body grid grid-cols-2 gap-3">
                <button
                    class="pos-choice-button flat-card p-4 text-left cursor-pointer hover:!border-accent-primary {selectedManualDiscountId === '' ? '!border-accent-primary' : ''}"
                    on:click={() => selectManualDiscount('')}
                >
                    <strong class="block text-text-main">No manual discount</strong>
                    <span class="text-sm text-text-muted">Remove the selected percentage discount</span>
                </button>
                {#each $discountsDB.filter(d => d.kind === 'manual_percent' && d.isActive) as discount}
                    <button
                        class="pos-choice-button flat-card p-4 text-left cursor-pointer hover:!border-accent-primary {selectedManualDiscountId === discount.id ? '!border-accent-primary' : ''}"
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
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: closeScaleModal }}
            class="scale-workspace"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scale-dialog-title"
        >
            <header class="scale-header">
                <div>
                    <span class="scale-kicker">Manual weighing</span>
                    <h2 id="scale-dialog-title">Scale</h2>
                    <p>Select a product, enter its weight, then add the calculated total.</p>
                </div>
                <button class="modal-close scale-close" aria-label="Close scale dialog" on:click={closeScaleModal}>✕</button>
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
                    <div class="search-controls search-controls-fill">
                        <div class="search-primary">
                            <SearchField
                                id="pos-scale-product-search"
                                bind:value={scaleSearch}
                                placeholder="Search weighable products, SKU, barcode, or PLU..."
                                ariaLabel="Search weighable products"
                                keyboardLabel="Open scale product search keyboard"
                                onInput={() => (scalePage = 0)}
                                onClear={() => (scalePage = 0)}
                            />
                        </div>
                    </div>
                    {#if visibleScaleProducts.length}
                        <div class="scale-product-grid">
                            {#each pagedScaleProducts as product}
                                {#if product}
                                    <button
                                        class="scale-product {product.image ? 'with-image' : ''} {selectedScaleProductId === product.id ? 'selected' : ''}"
                                        style="--scale-color: {product.color || '#3b82f6'}"
                                        aria-pressed={selectedScaleProductId === product.id}
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
                                        {#if selectedScaleProductId === product.id}
                                            <span class="scale-product-check" aria-hidden="true">
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                                    <path d="m5 12 4 4L19 6"></path>
                                                </svg>
                                            </span>
                                        {/if}
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
                    <div class="scale-selected {selectedScaleProduct ? 'has-product' : ''}">
                        <div class="scale-selected-copy">
                            <span>Selected product</span>
                            <strong>{selectedScaleProduct?.name || "Choose a product"}</strong>
                            <small>{selectedScaleProduct ? `${formatMoney(selectedScaleProduct.price)} per kilogram` : "Select one of the product tiles to continue."}</small>
                        </div>
                        {#if selectedScaleProduct}
                            <span class="scale-selected-ready" aria-label="Product selected">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="m5 12 4 4L19 6"></path>
                                </svg>
                            </span>
                        {/if}
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
                            <small>{scaleReadStatus || (scaleHardwareReady ? "Press Read Scale when the weight is stable." : "Use Printer Setup to choose the scale port.")}</small>
                        </div>
                        <button class="btn btn-secondary" disabled={!scaleHardwareReady || scaleReadBusy} on:click={() => readScaleNow(true)}>
                            {scaleReadBusy ? "Reading..." : "Read Scale"}
                        </button>
                    </div>
                    <div class="scale-numpad">
                        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"] as key}
                            <button
                                type="button"
                                class="np-btn payment-np-button"
                                class:is-delete={key === "⌫"}
                                aria-label={key === "⌫" ? "Delete last weight digit" : key === "." ? "Enter decimal point" : `Enter ${key}`}
                                title={key === "⌫" ? "Delete last digit" : undefined}
                                on:click={() => handleScaleKey(key)}
                            >
                                {#if key === "⌫"}
                                    <DeleteIcon size={25} strokeWidth={2.35} aria-hidden="true" />
                                {:else}
                                    {key}
                                {/if}
                            </button>
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
        class="modal-overlay"
        data-pos-modal-overlay
    >
        <div
            use:modalFocusTrap={{ dismiss: () => (showNumpad = false) }}
            class="quantity-pad-modal w-80 max-w-[95vw] max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6 rounded-md bg-bg-card flex flex-col gap-4 shadow-[var(--shadow)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quantity-dialog-title"
        >
            <div class="flex justify-between items-center">
                <h3 id="quantity-dialog-title" class="m-0 text-lg font-semibold">Enter Quantity</h3>
                <button
                    type="button"
                    class="modal-close"
                    aria-label="Close quantity dialog"
                    on:click={() => (showNumpad = false)}>✕</button
                >
            </div>
            <div
                class="np-display payment-display quantity-pad-display"
                role="spinbutton"
                aria-live="polite"
                aria-label="Selected quantity"
                aria-valuemin="0"
                aria-valuemax={MAX_CART_QUANTITY}
                aria-valuenow={parseInt(numpadValue) || 0}
                tabindex="0"
            >
                {numpadValue || "0"}
            </div>
            <div
                class="np-grid payment-np-grid quantity-np-grid"
                role="group"
                aria-label="Quantity number pad"
            >
                {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"] as key}
                    <button
                        type="button"
                        class="np-btn payment-np-button"
                        class:pos-pad-clear={key === "C"}
                        class:is-delete={key === "⌫"}
                        aria-label={key === "C" ? "Clear quantity" : key === "⌫" ? "Delete last quantity digit" : `Enter ${key}`}
                        title={key === "⌫" ? "Delete last digit" : undefined}
                        on:click={() => handleNumpadKey(key)}
                    >
                        {#if key === "⌫"}
                            <DeleteIcon size={26} strokeWidth={2.35} aria-hidden="true" />
                        {:else if key === "C"}
                            Clear
                        {:else}
                            {key}
                        {/if}
                    </button>
                {/each}
            </div>
            <button
                type="button"
                class="btn btn-success quantity-pad-enter"
                on:click={() => handleNumpadKey("ENTER")}
            >
                Enter Quantity
            </button>
        </div>
    </div>
{/if}

<!-- Change Price Modal -->
{#if showChangePricePad}
    <div
        class="modal-overlay"
        data-pos-modal-overlay
    >
        <div
            use:modalFocusTrap={{ dismiss: () => (showChangePricePad = false) }}
            class="change-price-modal w-96 max-w-[95vw] max-h-[calc(100dvh-2rem)] overflow-y-auto p-6 rounded-md bg-bg-card flex flex-col gap-4 shadow-[var(--shadow)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="change-price-dialog-title"
        >
            <div class="flex justify-between items-center">
                <h3 id="change-price-dialog-title" class="m-0 text-lg font-semibold">Change Price</h3>
                <button
                    class="modal-close"
                    aria-label="Close price dialog"
                    on:click={() => (showChangePricePad = false)}>✕</button
                >
            </div>
            <div
                class="np-display payment-display change-price-display"
                role="spinbutton"
                aria-live="polite"
                aria-label="New item price"
                aria-valuemin="0"
                aria-valuemax={MAX_ORDER_TOTAL_PENCE}
                aria-valuenow={parseInt(changePriceString || "0")}
                aria-valuetext={formatMoney(parseInt(changePriceString || "0"))}
                tabindex="0"
            >
                {formatMoney(parseInt(changePriceString || "0"))}
            </div>
            <div class="np-grid payment-np-grid change-price-np-grid" role="group" aria-label="Change price number pad">
                {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "C"] as key}
                    <button
                        type="button"
                        class="np-btn payment-np-button"
                        class:pos-pad-clear={key === "C"}
                        class:is-double-zero={key === "00"}
                        aria-label={key === "C" ? "Clear new price" : key === "00" ? "Enter double zero" : `Enter ${key}`}
                        on:click={() => handleChangePriceKey(key)}
                    >
                        {key === "C" ? "Clear" : key}
                    </button>
                {/each}
            </div>
            <div class="change-price-actions flex flex-col gap-2 mt-2">
                <button
                    class="btn btn-primary w-full h-14"
                    on:click={changePriceOnce}
                    >Change only for this order</button
                >
                <button
                    class="btn btn-danger w-full h-14"
                    on:click={changePricePermanently}>Change permanently</button
                >
            </div>
        </div>
    </div>
{/if}

<!-- Goods / Open Price Modal -->
{#if showGoodsModal}
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: () => (showGoodsModal = false) }}
            class="w-[700px] max-w-[95vw] max-h-[85vh] md:max-h-[90vh] flex flex-col md:flex-row p-0 overflow-y-auto md:overflow-hidden bg-bg-card border border-border-flat rounded-md"
            role="dialog"
            aria-modal="true"
            aria-label="Goods and open price"
        >
            <!-- Left Side: Open Departments -->
            <div
                class="flex-1 border-r border-border-flat flex flex-col bg-bg-base"
            >
                <div class="p-5 border-b border-border-flat bg-bg-panel">
                    <h3 class="m-0 text-[1.2rem]">Select Department</h3>
                    <div class="search-controls search-controls-fill mt-2">
                        <div class="search-primary">
                            <SearchField
                                id="goods-department-search"
                                bind:value={goodsSearchQuery}
                                placeholder="Filter departments..."
                                ariaLabel="Filter goods departments"
                                keyboardLabel="Open goods filter keyboard"
                            />
                        </div>
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
            <div class="goods-price-pad w-full md:w-[340px] p-4 sm:p-6 flex flex-col bg-bg-card">
                <div class="modal-header">
                    <h3>Enter Price</h3>
                    <button
                        type="button"
                        data-modal-initial-focus
                        class="modal-close"
                        aria-label="Close goods price dialog"
                        on:click={() => (showGoodsModal = false)}>✕</button
                    >
                </div>
                <div class="payment-display-row mb-4 mt-2">
                    <div
                        class="np-display payment-display goods-price-display"
                        role="spinbutton"
                        aria-live="polite"
                        aria-label="Goods price"
                        aria-valuemin="0"
                        aria-valuenow={parseInt(goodsPriceString || "0")}
                        aria-valuetext={formatMoney(parseInt(goodsPriceString || "0"))}
                        tabindex="0"
                    >
                        {formatMoney(parseInt(goodsPriceString || "0"))}
                    </div>
                    <button
                        type="button"
                        class="payment-clear-button"
                        aria-label="Clear goods price"
                        title="Clear price"
                        on:click={() => handleGoodsPadKey("C")}
                    >
                        Clear
                    </button>
                </div>
                <div
                    class="np-grid payment-np-grid goods-np-grid"
                    role="group"
                    aria-label="Goods price number pad"
                >
                    {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"] as key}
                        <button
                            type="button"
                            class="np-btn payment-np-button"
                            class:is-delete={key === "⌫"}
                            class:is-double-zero={key === "00"}
                            aria-label={key === "⌫" ? "Delete last goods price digit" : key === "00" ? "Enter double zero" : `Enter ${key}`}
                            title={key === "⌫" ? "Delete last digit" : undefined}
                            on:click={() => handleGoodsPadKey(key)}
                        >
                            {#if key === "⌫"}
                                <DeleteIcon size={28} strokeWidth={2.35} aria-hidden="true" />
                            {:else}
                                {key}
                            {/if}
                        </button>
                    {/each}
                </div>
            </div>
        </div>
    </div>
{/if}

<!-- Payment Modal -->
{#if showPaymentModal}
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: closePayment, dismissDisabled: isCompletingSale }}
            class="payment-modal"
            class:is-cash={paymentMethod === 'cash'}
            class:is-card={paymentMethod === 'card'}
            class:is-account={paymentMethod === 'account'}
            role="dialog"
            aria-modal="true"
            aria-labelledby="payment-dialog-title"
        >
            <div class="payment-modal-header">
                <h2 id="payment-dialog-title">Payment</h2>
                <button
                    bind:this={paymentCustomerToggle}
                    class="payment-customer-toggle"
                    aria-expanded={paymentCustomerSearchOpen}
                    aria-controls="payment-customer-search-panel"
                    disabled={isCompletingSale}
                    on:click={togglePaymentCustomerSearch}
                >
                    <UsersRound size={18} aria-hidden="true" />
                    <span>{selectedCustomer ? 'Change customer' : 'Find customer'}</span>
                </button>
                <button type="button" class="payment-customer-toggle" disabled={isCompletingSale || newPaymentCustomerSaving} on:click={openNewPaymentCustomer}>
                    <span aria-hidden="true">＋</span><span>New customer</span>
                </button>
                <button class="modal-close payment-close" aria-label="Close payment" title="Close payment"
                    disabled={isCompletingSale} on:click={closePayment}><X size={20} aria-hidden="true" /></button>
            </div>

                <section class="payment-loyalty" aria-label="Customer and loyalty">
                    {#if paymentCustomerSearchOpen}
                        <div class="payment-loyalty-search" id="payment-customer-search-panel">
                            <label for="payment-customer-search">Find a customer for loyalty or Pay later</label>
                            <SearchField
                                id="payment-customer-search"
                                bind:inputElement={customerSearchInput}
                                bind:value={customerSearch}
                                placeholder="Name, loyalty code, phone or postcode"
                                ariaLabel="Search customer accounts and loyalty"
                                keyboardLabel="Open customer search keyboard"
                                clearLabel="Clear customer search"
                                disabled={isCompletingSale}
                                onKeydown={handleCustomerSearchKeydown}
                            />
                            {#if customerMatches.length > 0}
                                <div class="payment-customer-results" aria-label="Matching customers">
                                    {#each customerMatches as customer}
                                        <button disabled={isCompletingSale} on:click={() => selectPaymentCustomer(customer)}>
                                            <strong>{customer.name}</strong>
                                            <small>{customer.loyaltyCode || 'No loyalty code'} · {customer.postcode || 'No postcode'}</small>
                                        </button>
                                    {/each}
                                </div>
                            {:else if customerSearch.trim()}
                                <p class="payment-search-empty" role="status">No matching customers.</p>
                            {/if}
                        </div>
                    {:else if selectedCustomer}
                        <div class="payment-customer-card" aria-live="polite" aria-busy={customerAccountBusy}>
                            <div class="payment-customer-details">
                                <span class="payment-customer-avatar" aria-hidden="true"><UsersRound size={20} strokeWidth={2.2} /></span>
                                <div class="payment-customer-identity">
                                    <strong title={selectedCustomer.name}>{selectedCustomer.name}</strong>
                                    <span>{selectedCustomer.loyaltyCode || 'No loyalty code'}</span>
                                </div>
                            </div>
                            <div class="payment-customer-balance">
                                {#if loyaltyConfig.enabled}
                                    <span><small>Points</small><b>{Number(selectedCustomer.loyaltyPoints || 0).toLocaleString()}</b></span>
                                    <span><small>Loyalty value</small><b>{formatMoney(availableLoyaltyCredit)}</b></span>
                                {/if}
                                {#if customerAccountBusy}
                                    <span><small>Account</small><b>Checking…</b></span>
                                    <span><small>Pay later</small><b>Checking…</b></span>
                                {:else if customerAccountLoadError}
                                    <span><small>Account</small><b class="account-unavailable">Unavailable</b></span>
                                    <span><small>Pay later</small><b class="account-unavailable">Unavailable</b></span>
                                {:else if (selectedCustomerAccount?.balancePence || 0) < 0}
                                    <span><small>Account credit</small><b class="is-earned">{formatMoney(Math.abs(selectedCustomerAccount?.balancePence || 0))}</b></span>
                                    <span><small>Pay later</small><b>{selectedCustomerAccount?.isEnabled ? 'Enabled' : 'Not enabled'}</b></span>
                                {:else}
                                    <span><small>Amount owed</small><b class:account-owed={(selectedCustomerAccount?.balancePence || 0) > 0}>{formatMoney(selectedCustomerAccount?.balancePence || 0)}</b></span>
                                    <span><small>Pay later</small><b>{selectedCustomerAccount?.isEnabled ? 'Enabled' : 'Not enabled'}</b></span>
                                {/if}
                            </div>
                            <div class="payment-customer-actions">
                                {#if loyaltyConfig.enabled}
                                    <button class="payment-customer-credit {useLoyaltyCredit ? 'active' : ''}" disabled={loyaltyCreditBusy || isCompletingSale || cashShortcutBusy} on:click={toggleLoyaltyCredit}>
                                        {loyaltyCreditBusy
                                            ? 'Checking...'
                                            : useLoyaltyCredit
                                                ? `Using ${formatMoney(loyaltyCreditUsed)}`
                                                : availableLoyaltyCredit > 0
                                                    ? loyaltyRedemptionAvailable ? `Use ${formatMoney(availableLoyaltyCredit)}` : 'Reconnect & use'
                                                    : 'No loyalty value'}
                                    </button>
                                {/if}
                                <button class="btn-icon payment-customer-remove" aria-label="Remove selected customer" title="Remove selected customer" disabled={isCompletingSale} on:click={removePaymentCustomer}>
                                    <X size={18} strokeWidth={2.4} aria-hidden="true" />
                                </button>
                            </div>
                        </div>
                    {:else}
                        <div class="payment-customer-walk-in">
                            <UsersRound size={22} aria-hidden="true" />
                            <div><strong>Walk-in customer</strong><span>Add a customer for loyalty or Pay later</span></div>
                        </div>
                    {/if}
                </section>

            <div class="payment-body">
                <div class="payment-summary">
                    <div class="payment-methods" role="group" aria-label="Payment method">
                        <button
                            type="button"
                            disabled={isCompletingSale}
                            class:is-active={paymentMethod === "cash"}
                            aria-pressed={paymentMethod === "cash"}
                            on:click={() => selectPaymentMethod("cash")}
                        >
                            <span class="payment-method-symbol" aria-hidden="true">£</span>
                            <span>Cash</span>
                        </button
                        >
                        <button
                            type="button"
                            disabled={isCompletingSale}
                            class:is-active={paymentMethod === "card"}
                            aria-pressed={paymentMethod === "card"}
                            on:click={() => selectPaymentMethod("card")}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                                <path d="M3 10h18M7 15h4"></path>
                            </svg>
                            <span>{managedProviderName}</span>
                        </button
                        >
                        <button
                            type="button"
                            disabled={isCompletingSale || customerAccountBusy}
                            class:is-active={paymentMethod === "account"}
                            aria-pressed={paymentMethod === "account"}
                            title={!selectedCustomer
                                ? 'Select a customer first'
                                : customerAccountLoadError
                                    ? 'The customer account could not be verified; select the customer again to retry'
                                    : paymentDue <= 0
                                        ? 'Nothing remains to charge to the customer account'
                                : !selectedCustomerAccount?.isEnabled
                                    ? 'Pay later is not enabled for this customer'
                                    : !accountLimitAllowsSale
                                        ? 'This sale exceeds the customer account limit'
                                        : 'Charge the remaining amount to this customer'}
                            on:click={() => selectPaymentMethod("account")}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                <path d="M4 5h16v14H4z"></path>
                                <path d="M8 9h8M8 13h5"></path>
                            </svg>
                            <span>Pay later</span>
                        </button>
                    </div>


                    <section class="payment-totals" aria-label="Payment totals">
                        <div class="payment-total-card">
                            <div class="payment-total-copy">
                                <span>{paymentMethod === 'card' ? paymentInputAmount > 0 && paymentInputAmount < paymentDue ? 'Card balance' : 'Card payment' : paymentMethod === 'account' ? 'Charge to account' : 'Amount due'}</span>
                                <small>{cart.length} {cart.length === 1 ? 'line' : 'lines'} in trolley</small>
                            </div>
                            <strong>{formatMoney(paymentMethod === 'card' && paymentInputAmount > 0 && paymentInputAmount < paymentDue ? paymentDue - paymentInputAmount : paymentDue)}</strong>
                        </div>
                        {#if loyaltyCreditUsed > 0}
                            <div class="payment-loyalty-applied">
                                <span>Loyalty credit · order {formatMoney(total)}</span>
                                <strong>−{formatMoney(loyaltyCreditUsed)}</strong>
                            </div>
                        {/if}
                        {#if paymentMethod === 'cash'}
                            <div class="payment-cash-totals" aria-live="polite" aria-atomic="true">
                                <div class="payment-received"><span>Cash received</span><strong>{formatMoney(paymentInputAmount)}</strong></div>
                                <div class="payment-change" class:is-ready={paymentInputAmount >= paymentDue}>
                                    <span>{paymentInputAmount >= paymentDue ? 'Change to give' : 'Remaining'}</span>
                                    <strong>{formatMoney(Math.abs(paymentInputAmount - paymentDue))}</strong>
                                </div>
                            </div>
                        {:else if paymentMethod === 'card' && paymentInputAmount > 0 && paymentInputAmount < paymentDue}
                            <div class="payment-split-row"><span>Cash received</span><strong>{formatMoney(paymentInputAmount)}</strong></div>
                            <button class="payment-edit-cash" disabled={isCompletingSale} on:click={() => selectPaymentMethod('cash')}>Edit cash amount</button>
                        {/if}
                    </section>

                    {#if paymentMethod === 'cash'}
                        <div class="payment-cash-options">
                            <div class="payment-section-heading">
                                <span>Pay now</span>
                                <small>Completes the sale</small>
                            </div>
                            <div class="payment-quick-grid">
                                <button
                                    type="button"
                                    class="payment-quick-button"
                                    aria-label={`Pay exact ${formatMoney(paymentDue)} now and complete sale`}
                                    disabled={isCompletingSale || cashShortcutBusy || loyaltyCreditBusy}
                                    on:click={() => setAmountAndComplete(paymentDue)}
                                >
                                    <span>Pay exact</span>
                                    <strong>{formatMoney(paymentDue)}</strong>
                                    <small>No change</small>
                                </button>
                            {#if nextPoundAmount !== null}
                                <button
                                    type="button"
                                    class="payment-quick-button payment-quick-rounded"
                                    aria-label={`Pay ${formatMoney(nextPoundAmount)} now and complete sale with ${formatMoney(nextPoundAmount - paymentDue)} change`}
                                    disabled={isCompletingSale || cashShortcutBusy || loyaltyCreditBusy}
                                    on:click={() =>
                                        setAmountAndComplete(nextPoundAmount!)}
                                >
                                    <span>Pay rounded</span>
                                    <strong>{formatMoney(nextPoundAmount)}</strong>
                                    <small>{formatMoney(nextPoundAmount - paymentDue)} change</small>
                                </button>
                            {/if}
                            </div>
                            <div class="payment-section-heading payment-notes-heading">
                                <span>Pay with notes</span>
                                <small>Finishes when fully paid</small>
                            </div>
                            <div class="payment-note-grid">
                            {#each fixedQuickAmounts as amt}
                                <button
                                    type="button"
                                    class="payment-note-button"
                                    data-note={amt / 100}
                                    aria-label={`Add ${formatMoney(amt)} cash${paymentInputAmount + amt >= paymentDue ? ' and complete sale' : ''}`}
                                    disabled={isCompletingSale || cashShortcutBusy || loyaltyCreditBusy || paymentDue <= 0}
                                    on:click={() => addQuickAmount(amt)}
                                >
                                    <img src={`/payment-notes/gbp-${amt / 100}.jpg`} alt="" aria-hidden="true" draggable="false" width="240" height="126" />
                                    <span class="payment-note-label"><span aria-hidden="true">+</span><strong>£{amt / 100}</strong></span>
                                </button>
                            {/each}
                            </div>
                        </div>
                    {/if}
                </div>

                {#if paymentMethod === 'cash'}
                    <div class="payment-pad">
                        <div class="payment-pad-heading">
                            <span>Enter cash received</span>
                            <small>Number pad</small>
                        </div>
                        <div class="payment-display-row">
                            <div
                                class="np-display payment-display"
                                id="payment-amount-received"
                                data-modal-initial-focus
                                role="spinbutton"
                                aria-live="polite"
                                aria-label="Amount received"
                                aria-valuemin="0"
                                aria-valuemax={MAX_ORDER_TOTAL_PENCE}
                                aria-valuenow={paymentInputAmount}
                                aria-valuetext={formatMoney(paymentInputAmount)}
                                tabindex="0"
                                title="Use the number keys or tap the pad to enter cash received"
                            >
                                {formatMoney(paymentInputAmount)}
                            </div>
                            <button
                                class="payment-clear-button"
                                aria-label="Clear amount received"
                                title="Clear amount"
                                disabled={isCompletingSale}
                                on:click={clearPaymentInput}
                            >Clear</button>
                        </div>
                        <div
                            class="np-grid payment-np-grid {isCompletingSale ? 'opacity-35 pointer-events-none' : ''}"
                            role="group"
                            aria-label="Cash amount number pad"
                        >
                            {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"] as key}
                                <button
                                    type="button"
                                    class="np-btn payment-np-button"
                                    class:is-delete={key === "⌫"}
                                    class:is-double-zero={key === "00"}
                                    aria-label={key === "⌫" ? "Delete last amount digit" : key === "00" ? "Enter double zero" : `Enter ${key}`}
                                    title={key === "⌫" ? "Delete last digit" : undefined}
                                    disabled={isCompletingSale}
                                    on:click={() => handlePaymentPadKey(key)}
                                >
                                    {#if key === "⌫"}
                                        <DeleteIcon size={28} strokeWidth={2.35} aria-hidden="true" />
                                    {:else}
                                        {key}
                                    {/if}
                                </button>
                            {/each}
                        </div>
                    </div>
                    {:else if paymentMethod === 'card'}
                        <div class="payment-card-terminal">
                            <div class="payment-card-terminal-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                                    <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                                    <path d="M3 10h18M7 15h4"></path>
                                </svg>
                            </div>
                            <div class="payment-terminal-copy">
                                <strong>{managedTerminalName}</strong>
                                <span role="status">{managedCardEnabled
                                    ? terminalPaymentMessage || ($connectionState.mode !== 'multi' || !$connectionState.mysqlOnline ? 'Waiting for the shared database connection' : `Ready to send to ${managedProviderName}`)
                                    : 'Take payment on your card terminal, then confirm below.'}</span>
                            </div>
                            {#if managedCardEnabled && isCompletingSale && !['approved', 'saving'].includes(terminalPaymentStage)}
                                <button class="btn btn-danger payment-terminal-cancel" disabled={terminalPaymentStage === 'cancelling' || terminalCancelRequested} on:click={cancelManagedTerminalPayment}>
                                    {terminalPaymentStage === 'cancelling' ? 'Cancelling…' : terminalCancelRequested ? 'Cancellation unconfirmed' : 'Cancel Terminal'}
                                </button>
                            {/if}
                        </div>
                    {:else}
                        <div class="payment-account-summary" aria-live="polite">
                            {#if selectedCustomer && selectedCustomerAccount}
                                <div><span>{selectedCustomerAccount.balancePence < 0 ? 'Account credit' : 'Currently owes'}</span><strong>{formatMoney(Math.abs(selectedCustomerAccount.balancePence))}</strong></div>
                                <div><span>{accountBalanceAfterSale < 0 ? 'Credit after sale' : 'After this sale'}</span><strong>{formatMoney(Math.abs(accountBalanceAfterSale))}</strong></div>
                                <small>{selectedCustomerAccount.creditLimitPence > 0 ? `Account limit ${formatMoney(selectedCustomerAccount.creditLimitPence)}` : 'No account limit set'}</small>
                            {:else}
                                <p>Select a customer with Pay later enabled.</p>
                            {/if}
                            <small>This records a debt on the customer’s account.</small>
                        </div>
                {/if}
            </div>
            <div class="payment-result-actions">
                {#if paymentMethod === "account"}
                    <div
                        class="payment-footer-message" class:is-error={!accountSaleAvailable} role="status"
                    >
                        {customerAccountBusy
                            ? 'Checking customer account…'
                            : !selectedCustomer
                                ? 'Select a customer to use Pay later'
                                : customerAccountLoadError
                                    ? 'The customer account could not be verified. Select the customer again to retry'
                                    : paymentDue <= 0
                                        ? 'Nothing remains to charge to the customer account'
                                : !selectedCustomerAccount?.isEnabled
                                    ? 'Pay later is not enabled for this customer'
                                    : !accountLimitAllowsSale
                                        ? 'This sale exceeds the customer account limit'
                                        : $connectionState.mode === 'multi' && !$connectionState.mysqlOnline
                                            ? 'MariaDB must be online for Pay later'
                                            : !hasPermission($currentEmployee, 'charge_customer_account', $settingsDB)
                                                ? 'Permission required to charge customer accounts'
                                                : `${formatMoney(paymentDue)} will be added to ${selectedCustomer.name}'s account`}
                    </div>
                {:else if paymentMethod === 'card' && managedCardEnabled && isCompletingSale}
                    <div
                        class="payment-footer-message" role="status"
                    >
                        {terminalPaymentMessage || `Connecting to ${managedProviderName}`}
                    </div>
                {:else if paymentMethod === 'card' && managedCardEnabled && ($connectionState.mode !== "multi" || !$connectionState.mysqlOnline)}
                    <div
                        class="payment-footer-message is-error" role="status"
                    >
                        Reconnect to the shared database before taking a terminal payment.
                    </div>
                {:else if cardCashPartInvalid}
                    <p class="payment-footer-message is-error" role="status">Cash part must be less than total. Return to Cash to edit it.</p>
                {:else}
                    <p class="payment-footer-message">
                        {paymentMethod === 'cash'
                            ? paymentInputAmount < paymentDue ? 'Enter cash received, or choose Pay now.' : 'Check the change, then complete the sale.'
                            : managedCardEnabled ? `Send payment to ${managedProviderName} when ready.` : 'Confirm only after the card terminal approves.'}
                    </p>
                {/if}
                <button
                    class="payment-complete-btn btn btn-success disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                    disabled={paymentCompleteDisabled}
                    on:click={completeSale}
                >
                    {isCompletingSale
                        ? (managedCardEnabled && paymentMethod === 'card' ? `Processing ${managedProviderName}...` : 'Saving Sale...')
                        : paymentMethod === 'account'
                            ? 'Confirm Pay Later'
                            : (managedCardEnabled && paymentMethod === 'card' ? `Send to ${managedProviderName}` : paymentMethod === 'card' ? 'Confirm Card Payment' : 'Complete Sale')}
                </button>
            </div>
        </div>
    </div>
{/if}

{#if showPaymentModal && showNewPaymentCustomer && newPaymentCustomer}
    <div class="modal-overlay checkout-customer-overlay" data-pos-modal-overlay>
        <div
            class="checkout-customer-dialog"
            use:modalFocusTrap={{ dismiss: closeNewPaymentCustomer, dismissDisabled: newPaymentCustomerSaving }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkout-new-customer-title"
            aria-busy={newPaymentCustomerSaving}
        >
            <header class="checkout-customer-header">
                <h2 id="checkout-new-customer-title">New customer</h2>
                <button type="button" class="modal-close" aria-label="Close new customer" disabled={newPaymentCustomerSaving} on:click={closeNewPaymentCustomer}><X size={20} aria-hidden="true" /></button>
            </header>
            <div class="checkout-customer-body">
                <CheckoutCustomerForm
                    bind:draft={newPaymentCustomer}
                    saving={newPaymentCustomerSaving}
                    error={newPaymentCustomerError}
                    offline={$connectionState.mode === 'multi' && !$connectionState.mysqlOnline}
                    onSave={saveNewPaymentCustomer}
                    onCancel={closeNewPaymentCustomer}
                />
            </div>
        </div>
    </div>
{/if}

<!-- Held Orders Modal -->
{#if showHeldOrders}
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: () => (showHeldOrders = false) }}
            class="w-[420px] max-w-[95vw] max-h-[85vh] md:max-h-[90vh] overflow-y-auto p-4 sm:p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="held-orders-dialog-title"
        >
            <div class="modal-header">
                <h3 id="held-orders-dialog-title">Retrieve Trolleys ({heldOrdersForTill.length})</h3>
                <button
                    class="modal-close"
                    aria-label="Close held trolleys dialog"
                    on:click={() => (showHeldOrders = false)}>✕</button
                >
            </div>
            {#if pendingHeldRecovery && !activeHeldRecovery}
                <div class="rounded-md border border-amber-300 bg-amber-50 p-3 flex flex-col gap-2 text-sm text-amber-950">
                    <strong>An interrupted trolley is saved on this till.</strong>
                    <span>Recovery checks the claim and any saved payment before restoring it.</span>
                    <button type="button" class="btn-primary min-h-[44px]" disabled={!!retrievingHeldOrderId || cart.length > 0} on:click={recoverInterruptedTrolley}>
                        {retrievingHeldOrderId ? 'Checking…' : 'Recover interrupted trolley'}
                    </button>
                </div>
            {/if}
            <div class="held-order-tabs" aria-label="Choose held trolley source">
                <button
                    type="button"
                    class:is-active={heldOrderView === "this"}
                    class="is-own"
                    on:click={() => (heldOrderView = "this")}
                >
                    <b>{ownHeldOrderCount}</b>
                    <span>This till</span>
                </button>
                <button
                    type="button"
                    class:is-active={heldOrderView === "other"}
                    class="is-shared"
                    on:click={() => (heldOrderView = "other")}
                >
                    <b>{otherTillHeldOrderCount}</b>
                    <span>Other tills</span>
                </button>
            </div>
            <div class="overflow-y-auto flex flex-col gap-2">
                {#each visibleHeldOrders as ho, holdIndex}
                    {@const lines = heldOrderLinesByOrder.get(ho.id) || []}
                    {@const isOtherTill = ho.tillNumber !== tillId}
                    <button
                        type="button"
                        class="held-order-card"
                        class:is-other-till={isOtherTill}
                        disabled={cart.length > 0 || Boolean(retrievingHeldOrderId)}
                        on:click={() => retrieveOrder(ho.id)}
                    >
                        <span class="held-order-number">{holdIndex + 1}</span>
                        <div class="held-order-content">
                            <div class="held-order-heading">
                                <div>
                                    <strong>{isOtherTill ? 'Shared trolley' : 'This till'}</strong>
                                    <span>{isOtherTill ? ho.tillName || ho.tillNumber || 'Other till' : tillName}</span>
                                </div>
                                <time datetime={ho.createdAt}>
                                    {new Date(ho.createdAt).toLocaleTimeString("en-GB", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                    })}
                                </time>
                            </div>
                            <div class="held-order-lines">
                                {#each lines.slice(0, 3) as l}<span
                                        >{getScaleSaleDisplay(l.notes, l.quantity, l.unitPrice, l.originalPrice).label} {l.productName}</span
                                    >{/each}
                                {#if lines.length > 3}<span>+{lines.length - 3} more</span>{/if}
                            </div>
                            <div class="held-order-total money">
                                {retrievingHeldOrderId === ho.id ? 'Retrieving...' : formatMoney(ho.total)}
                            </div>
                        </div>
                    </button>
                {/each}
                {#if heldOrdersLoading}<p
                        class="text-center text-text-muted p-5"
                    >
                        Loading held orders...
                    </p>{/if}
                {#if !heldOrdersLoading && visibleHeldOrders.length === 0}<p
                        class="text-center text-text-muted p-5"
                    >
                        {heldOrderView === "this" ? "No trolleys held on this till" : "No trolleys held on other tills"}
                    </p>{/if}
            </div>
        </div>
    </div>
{/if}

<!-- Recent Transactions Modal -->
{#if showRecentTransactions}
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{
                dismiss: () => {
                    if (!isReversingOrder) showRecentTransactions = false;
                },
                dismissDisabled: isReversingOrder,
            }}
            class="w-[900px] max-w-[95vw] max-h-[85vh] md:max-h-[95vh] overflow-y-auto p-4 sm:p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recent-transactions-dialog-title"
        >
            <div
                class="flex justify-between items-center border-b border-border-flat pb-4"
            >
                <h2 id="recent-transactions-dialog-title" class="m-0 text-text-main text-[1.5rem]">
                    Recent Transactions
                </h2>
                <button
                    class="modal-close"
                    aria-label="Close recent transactions dialog"
                    disabled={isReversingOrder}
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
                                                sku: $productById.get(line.productId)?.sku || '',
                                            }))}
                                        payments={getCachedReceiptPayments(selectedRecentOrderId)}
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
                                        >Amount Ref</button
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
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: dismissNotFoundModal }}
            class="w-[460px] max-w-[95vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-border-flat bg-bg-panel p-5 text-text-main shadow-[0_24px_70px_var(--shadow)] sm:p-6"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="not-found-dialog-title"
            aria-describedby="not-found-dialog-description not-found-dialog-code"
        >
            <div class="flex items-start gap-3.5">
                <div
                    class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-danger/20 bg-danger/10 text-danger"
                    aria-hidden="true"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="h-6 w-6"
                    >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 8v4" />
                        <path d="M12 16h.01" />
                    </svg>
                </div>
                <div class="min-w-0 flex-1 pt-0.5">
                    <span class="text-[0.7rem] font-black uppercase tracking-[0.12em] text-danger">Scan issue</span>
                    <h3 id="not-found-dialog-title" class="m-0 mt-1 text-xl font-black leading-tight">
                        No product matches this barcode
                    </h3>
                </div>
                <button
                    type="button"
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-transparent bg-transparent text-xl text-text-muted transition-colors hover:border-border-flat hover:bg-bg-card hover:text-text-main"
                    aria-label="Close product not found dialog"
                    on:click={dismissNotFoundModal}>✕</button
                >
            </div>

            <p id="not-found-dialog-description" class="mb-0 mt-4 text-[0.95rem] leading-relaxed text-text-muted">
                Check the scanned code and try again. If this is a new item, you can add it without leaving the sale.
            </p>

            <div class="mt-4 rounded-xl border border-border-flat bg-bg-card p-4">
                <div class="flex items-center gap-2 text-[0.7rem] font-black uppercase tracking-[0.1em] text-text-muted">
                    <ScanLine size={17} strokeWidth={2.3} aria-hidden="true" />
                    <span>Scanned barcode</span>
                </div>
                <code
                    id="not-found-dialog-code"
                    class="mt-2 block break-all rounded-lg border border-border-flat bg-bg-base px-3 py-2.5 text-center font-mono text-base font-black tracking-[0.08em] text-text-main"
                >{notFoundBarcode}</code>
            </div>

            <div class="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <button
                    bind:this={scanAgainButton}
                    type="button"
                    data-modal-initial-focus
                    class="btn btn-primary w-full"
                    on:click={dismissNotFoundModal}
                >
                    <ScanLine size={19} strokeWidth={2.4} aria-hidden="true" />
                    Scan again
                </button>
                <button
                    type="button"
                    class="btn btn-secondary w-full"
                    on:click={openQuickAdd}
                >
                    Add product
                </button>
            </div>
        </div>
    </div>
{/if}

{#if showQuickAddModal}
    <div
        class="modal-overlay"
        role="presentation"
        on:click={handleQuickAddBackdrop}
        on:keydown={(event) => event.key === "Escape" && closeQuickAdd()}
    >
        <div
            use:modalFocusTrap={{ dismiss: closeQuickAdd, dismissDisabled: quickAddBusy }}
            class="quick-add-modal w-[920px] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quick-add-dialog-title"
            aria-busy={quickAddBusy}
        >
            <div class="modal-header">
                <h3 id="quick-add-dialog-title">Quick Add Product</h3>
                <button
                    type="button"
                    class="modal-close"
                    aria-label="Close quick add product dialog"
                    disabled={quickAddBusy}
                    on:click={closeQuickAdd}>✕</button
                >
            </div>

            <div class="quick-add-content-grid grid grid-cols-1 min-[700px]:grid-cols-[1fr_0.9fr] gap-6 min-h-0">
                <div class="quick-add-fields grid grid-cols-1 sm:grid-cols-2 min-[700px]:grid-cols-1 gap-4 content-start">
                    <div class="input-group">
                        <label for="qa-name">Product Name *</label>
                        <input
                            id="qa-name"
                            type="text"
                            data-modal-initial-focus
                            disabled={quickAddBusy}
                            bind:value={quickAddName}
                            placeholder="Enter name..."
                            class="flat-input !py-3.5 !text-lg"
                        />
                    </div>

                    <div class="input-group">
                        <label for="qa-sku">SKU <span class="font-normal">(optional)</span></label>
                        <input
                            id="qa-sku"
                            type="text"
                            disabled={quickAddBusy}
                            bind:value={quickAddSku}
                            placeholder="Leave blank if not needed"
                            class="flat-input !py-3.5 !text-lg"
                        />
                    </div>

                    <div class="input-group">
                        <CustomSelect
                            label="Category *"
                            disabled={quickAddBusy}
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
                            disabled={quickAddBusy}
                            bind:value={quickAddTaxRateId}
                            options={$taxRatesDB.map((t) => ({
                                label: t.name,
                                value: t.id,
                            }))}
                        />
                    </div>

                    <label class="quick-add-age-toggle rounded-xl border border-border-flat bg-bg-panel p-3.5 flex items-center gap-3 cursor-pointer">
                        <input type="checkbox" bind:checked={quickAddAgeRestricted} disabled={quickAddBusy} />
                        <span class="flex min-w-0 flex-col gap-0.5">
                            <strong>18+ age-restricted item</strong>
                            <small class="text-text-muted">Cashiers must confirm a valid ID before adding it.</small>
                        </span>
                    </label>
                </div>

                <div class="quick-add-price-section flex flex-col gap-2">
                    <span class="text-[0.9rem] font-semibold text-text-muted">Price *</span>
                    <div class="payment-display-row">
                        <div
                            class="np-display payment-display quick-add-price-display"
                            role="spinbutton"
                            aria-live="polite"
                            aria-label="Quick add product price"
                            aria-valuemin="0"
                            aria-valuenow={parseInt(quickAddPrice) || 0}
                            aria-valuetext={formatMoney(parseInt(quickAddPrice) || 0)}
                            tabindex="0"
                        >
                            {formatMoney(parseInt(quickAddPrice) || 0)}
                        </div>
                        <button
                            type="button"
                            class="payment-clear-button"
                            aria-label="Clear quick add product price"
                            title="Clear price"
                            disabled={quickAddBusy}
                            on:click={() => handleQuickAddPriceKey("C")}
                        >
                            Clear
                        </button>
                    </div>
                    <div
                        class="np-grid payment-np-grid quick-add-np-grid"
                        role="group"
                        aria-label="Quick add product price number pad"
                    >
                        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"] as key}
                            <button
                                type="button"
                                class="np-btn payment-np-button"
                                class:is-delete={key === "⌫"}
                                class:is-double-zero={key === "00"}
                                disabled={quickAddBusy}
                                aria-label={key === "⌫" ? "Delete last quick add price digit" : key === "00" ? "Enter double zero" : `Enter ${key}`}
                                title={key === "⌫" ? "Delete last digit" : undefined}
                                on:click={() => handleQuickAddPriceKey(key)}
                            >
                                {#if key === "⌫"}
                                    <DeleteIcon size={28} strokeWidth={2.35} aria-hidden="true" />
                                {:else}
                                    {key}
                                {/if}
                            </button>
                        {/each}
                    </div>
                </div>
            </div>

            <div class="quick-add-actions grid grid-cols-1 min-[700px]:grid-cols-2 gap-3">
                <button
                    type="button"
                    class="btn btn-success h-16 text-lg"
                    disabled={quickAddBusy}
                    on:click={() => saveQuickProduct(false)}
                >
                    {quickAddBusy ? "Saving..." : "Save & Add to Cart"}
                </button>
                <button
                    type="button"
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

{#if pendingAgeRestrictedAdd}
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: cancelAgeRestrictedAdd }}
            class="w-[520px] max-w-[95vw] rounded-2xl border border-warning/40 bg-bg-card p-5 text-text-main shadow-[0_24px_70px_var(--shadow)] sm:p-6"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="age-restriction-dialog-title"
            aria-describedby="age-restriction-dialog-description"
        >
            <div class="flex items-start gap-4">
                <span class="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-warning/30 bg-warning/15 text-warning" aria-hidden="true">
                    <ShieldAlert size={30} strokeWidth={2.4} />
                </span>
                <div class="min-w-0 flex-1">
                    <span class="text-[0.72rem] font-black uppercase tracking-[0.14em] text-warning">18+ item</span>
                    <h2 id="age-restriction-dialog-title" class="m-0 mt-1 text-2xl font-black leading-tight">Age verification required</h2>
                    <p id="age-restriction-dialog-description" class="mb-0 mt-3 leading-relaxed text-text-muted">
                        Check valid photo ID and confirm the customer is aged 18 or over before adding this item.
                    </p>
                </div>
            </div>

            <div class="mt-5 rounded-xl border border-border-flat bg-bg-panel px-4 py-3">
                <small class="block text-[0.7rem] font-black uppercase tracking-[0.1em] text-text-muted">Restricted product</small>
                <strong class="mt-1 block text-lg">{pendingAgeRestrictedAdd.product.name}</strong>
            </div>

            <div class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button type="button" class="btn btn-secondary h-14" on:click={cancelAgeRestrictedAdd}>
                    Do Not Add
                </button>
                <button
                    bind:this={ageRestrictedConfirmButton}
                    type="button"
                    data-modal-initial-focus
                    class="btn btn-primary h-14"
                    on:click={confirmAgeRestrictedAdd}
                >
                    ID Checked — Add Item
                </button>
            </div>
        </div>
    </div>
{/if}

{#if showManagerApprovalModal}
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: cancelManagerApproval }}
            class="w-[520px] max-w-[95vw] max-h-[95vh] overflow-y-auto rounded-md border border-border-flat bg-bg-card p-5 flex flex-col gap-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manager-approval-dialog-title"
        >
            <div>
                <h2 id="manager-approval-dialog-title" class="m-0 text-xl">Approval Required</h2>
                <p class="mt-1 text-sm text-text-muted">
                    {managerApprovalTitle || permissionLabels[managerApprovalPermission]} needs approval before continuing.
                </p>
            </div>
            {#if managerApprovers.length === 0}
                <div class="rounded-xl border border-danger/40 bg-danger/10 p-4 text-danger">
                    No active manager, supervisor, or administrator has this permission. Update Role Permissions in Staff.
                </div>
            {:else}
                <CustomSelect
                    label="Approving staff member"
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
                on:click={cancelManagerApproval}
            >
                Cancel
            </button>
        </div>
    </div>
{/if}

{#if showPartialRefundPad && pendingReversal}
    <div class="modal-overlay">
        <div
            use:modalFocusTrap={{ dismiss: cancelPartialRefund, dismissDisabled: isReversingOrder }}
            class="w-[430px] max-w-[95vw] max-h-[95vh] overflow-y-auto p-5 rounded-md bg-bg-card border border-border-flat flex flex-col gap-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="partial-refund-dialog-title"
        >
            <div>
                <h2 id="partial-refund-dialog-title" class="m-0 text-xl">Amount Refund</h2>
                <p class="text-text-muted mt-1">
                    Enter the amount in pounds. This is a price adjustment and does not return item quantities to stock.
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
                on:click={cancelPartialRefund}>Cancel</button
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
    bind:show={showDojoSignatureConfirm}
    title="Verify Customer Signature"
    message="Compare the customer's signature with the card or merchant receipt, then accept or reject it. Dojo is still checking the payment while this dialog is open."
    confirmText="Accept Signature"
    cancelText="Reject Signature"
    dismissDisabled={true}
    on:confirm={() => finishDojoSignatureDecision(true)}
    on:cancel={() => finishDojoSignatureDecision(false)}
/>
<DojoRetryDialog bind:decide={dojoRetryDecision} />
<DojoExpiryReview bind:show={showCheckoutExpiryReview} attempt={checkoutExpiryAttempt}
    employeeId={$currentEmployee?.role === 'admin' ? $currentEmployee.id : ''} onSaved={finishCheckoutExpiryReview} />

<ConfirmDialog
    bind:show={showReversalConfirm}
    title={pendingReversal?.voiding ? "Void This Sale?" : "Confirm Refund?"}
    message={(pendingReversal?.voiding
        ? "This will void the complete sale, restore stock, and record a reversal. Void is allowed only in the original open till session."
        : pendingReversal?.partial
            ? `Refund ${formatMoney(toPence(Number(partialRefundInput || 0)))} as a goods amount adjustment? Stock quantities will not change. Tips, service charge and cashback are excluded.`
            : "This will refund the remaining goods balance and restore stock. Tips, service charge and cashback are excluded.")
        + ' ' + refundCardInstructions(getCachedReceiptPayments(pendingReversal?.orderId || ''))}
    confirmText={isReversingOrder ? "Processing..." : pendingReversal?.voiding ? "Void Sale" : "Confirm Refund"}
    variant="danger"
    on:confirm={confirmPendingReversal}
    on:cancel={() => {
        pendingReversal = null;
        partialRefundInput = "";
    }}
/>

<style>
    .device-back-office-shell-hidden {
        display: none;
    }

    .pos-admin-logo {
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        border-radius: .25rem;
        object-fit: contain;
    }

    .pos-pad-clear {
        color: var(--danger) !important;
        border-color: color-mix(in srgb, var(--danger) 42%, var(--border-flat)) !important;
        background: color-mix(in srgb, var(--danger) 7%, var(--bg-card)) !important;
        font-size: .9rem !important;
    }
    .pos-pad-clear:hover,
    .pos-pad-clear:focus-visible {
        color: #fff !important;
        border-color: var(--danger) !important;
        background: var(--danger) !important;
    }
    .quantity-pad-display,
    .goods-price-display,
    .quick-add-price-display {
        min-width: 0;
    }
    .quantity-pad-enter {
        min-height: 56px;
        font-size: 1rem;
        font-weight: 900;
        touch-action: manipulation;
    }
    .goods-np-grid,
    .quick-add-np-grid,
    .quantity-np-grid {
        grid-auto-flow: row;
    }
    @media (max-height: 700px) {
        .quantity-pad-modal {
            gap: .6rem;
            padding: .75rem;
        }
        .quantity-pad-enter {
            min-height: 48px;
        }
        .quick-add-modal {
            gap: .7rem;
            padding: .75rem 1rem;
        }
        .quick-add-content-grid,
        .quick-add-fields {
            gap: .65rem;
        }
        .quick-add-price-section {
            gap: .4rem;
        }
        .quick-add-actions {
            gap: .5rem;
        }
        .quick-add-actions .btn {
            height: 48px;
            min-height: 48px;
            font-size: .9rem;
        }
    }
    .login-overlay { position: fixed; z-index: 1000; inset: 0; padding: 1rem; display: grid; place-items: center; overflow: auto; background: var(--bg-base); }
    .login-form { width: min(780px, 100%); max-height: calc(100vh - 2rem); padding: 1.25rem; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-card); box-shadow: var(--shadow); }
    .login-form-picker { width: min(680px, 100%); }
    .login-brand-row { min-height: 48px; padding-bottom: .85rem; display: flex; align-items: center; gap: .65rem; border-bottom: 1px solid var(--border-flat); }
    .login-brand-mark { width: 42px; height: 42px; display: grid; place-items: center; flex: 0 0 auto; overflow: hidden; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-panel); }
    .login-brand-mark img { width: 32px; height: 32px; object-fit: contain; }
    .login-brand-copy { min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
    .login-brand-copy strong { overflow: hidden; color: var(--text-main); font-size: .9rem; text-overflow: ellipsis; white-space: nowrap; }
    .login-brand-copy small { margin-top: .16rem; color: var(--text-muted); font-size: .7rem; }
    .login-brand-actions { margin-left: auto; display: flex; align-items: center; gap: .55rem; }
    .login-fullscreen-button { width: 40px; height: 40px; display: grid; place-items: center; flex: 0 0 auto; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); }
    .login-fullscreen-button:hover, .login-fullscreen-button:focus-visible { color: var(--accent-primary); border-color: var(--accent-primary); background: var(--bg-card-hover); }
    .login-fullscreen-button:disabled { opacity: .55; cursor: wait; }
    .login-lock-icon { flex: 0 0 auto; color: var(--accent-primary); }
    .login-heading h1 { margin: 0; color: var(--text-main); font-size: 1.55rem; }
    .login-heading p { margin: .2rem 0 0; color: var(--text-muted); font-size: .85rem; }
    .login-staff-list { max-height: min(48vh, 420px); display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1px; overflow-y: auto; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--border-flat); }
    .login-staff-button { min-width: 0; min-height: 78px; padding: .7rem .8rem; display: grid; grid-template-columns: 46px minmax(0, 1fr) 22px; align-items: center; gap: .7rem; color: var(--text-main); text-align: left; background: var(--bg-panel); }
    .login-staff-button:hover, .login-staff-button:focus-visible { z-index: 1; background: var(--bg-card-hover); box-shadow: inset 3px 0 0 var(--accent-primary); }
    .login-staff-avatar, .login-person-avatar { display: grid; place-items: center; color: white; font-weight: 900; border-radius: .4rem; background: var(--accent-primary); }
    .login-staff-avatar { width: 46px; height: 46px; font-size: .9rem; }
    .login-staff-copy { min-width: 0; display: flex; flex-direction: column; gap: .12rem; }
    .login-staff-copy strong { overflow: hidden; font-size: .9rem; text-overflow: ellipsis; white-space: nowrap; }
    .login-staff-copy small { color: var(--text-muted); font-size: .72rem; }
    .login-support-button { min-width: 0; min-height: 62px; padding: .55rem .7rem; display: grid; grid-template-columns: 40px minmax(0, 1fr) 22px; align-items: center; gap: .65rem; color: var(--text-main); text-align: left; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-panel); }
    .login-support-button:hover, .login-support-button:focus-visible { color: var(--accent-primary); border-color: var(--accent-primary); background: var(--bg-card-hover); }
    .login-support-icon { width: 40px; height: 40px; display: grid; place-items: center; color: var(--success); border-radius: .4rem; background: color-mix(in srgb, var(--success) 12%, var(--bg-card)); }
    .login-support-button > span:nth-child(2) { min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
    .login-support-button strong { font-size: .82rem; }
    .login-support-button small { overflow: hidden; color: var(--text-muted); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
    .login-empty-state { padding: 1rem; text-align: center; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-panel); }
    .login-pin-layout { min-height: 410px; display: grid; grid-template-columns: minmax(210px, .72fr) minmax(300px, 1fr); align-items: stretch; gap: 1rem; }
    .login-person { min-height: 410px; padding: 1rem; display: flex; flex-direction: column; align-items: flex-start; gap: .3rem; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-panel); }
    .login-person-avatar { width: 54px; height: 54px; margin-bottom: .55rem; font-size: 1rem; }
    .login-person-label { color: var(--accent-primary); font-size: .66rem; font-weight: 900; text-transform: uppercase; }
    .login-person > strong { max-width: 100%; overflow: hidden; color: var(--text-main); font-size: 1.45rem; text-overflow: ellipsis; white-space: nowrap; }
    .login-person > small { color: var(--text-muted); font-size: .75rem; }
    .login-person > p:not(.login-error) { margin: .65rem 0 0; color: var(--text-muted); font-size: .78rem; }
    .login-error { min-height: 2.2rem; margin: .45rem 0 0; color: var(--text-muted); font-size: .75rem; font-weight: 700; line-height: 1.25; }
    .login-error.visible { color: var(--danger); }
    .login-change-user { width: 100%; margin-top: auto; }
    .login-pin-layout :global(.digit-pad) { min-height: 410px; }
    .login-pin-layout.back-office {
        min-height: 300px;
        grid-template-columns: minmax(220px, .72fr) minmax(320px, 1fr);
        align-items: stretch;
    }
    .login-pin-layout.back-office .login-person { min-height: 300px; }
    .login-desktop-pin {
        min-width: 0;
        min-height: 300px;
        padding: 1.35rem;
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr);
        grid-auto-rows: max-content;
        align-content: center;
        gap: .9rem .75rem;
        border: 1px solid var(--border-flat);
        border-radius: .5rem;
        background: var(--bg-panel);
    }
    .login-desktop-pin-icon {
        width: 42px;
        height: 42px;
        display: grid;
        place-items: center;
        grid-row: 1;
        color: var(--accent-primary);
        border: 1px solid color-mix(in srgb, var(--accent-primary) 38%, var(--border-flat));
        border-radius: .42rem;
        background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card));
    }
    .login-desktop-pin > div { min-width: 0; align-self: center; }
    .login-desktop-pin label { display: block; color: var(--text-main); font-size: .92rem; font-weight: 900; }
    .login-desktop-pin p { margin: .18rem 0 0; color: var(--text-muted); font-size: .73rem; }
    .login-desktop-pin-input {
        width: 100%;
        height: 46px;
        grid-column: 1 / -1;
        padding: 0 .85rem;
        border: 1px solid var(--border-flat);
        border-radius: .42rem;
        outline: none;
        background: var(--bg-card);
        color: var(--text-main);
        font-size: 1.1rem;
        font-weight: 850;
        letter-spacing: .18em;
    }
    .login-desktop-pin-input:focus {
        border-color: var(--accent-primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 22%, transparent);
    }
    .login-desktop-submit { width: 100%; grid-column: 1 / -1; min-height: 44px; }
    .login-desktop-pin > small {
        grid-column: 1 / -1;
        color: var(--text-muted);
        font-size: .69rem;
        text-align: center;
    }
    @media (max-height: 700px) and (min-width: 651px) {
        .login-form { gap: .7rem; padding: .85rem; }
        .login-brand-row { min-height: 40px; padding-bottom: .55rem; }
        .login-brand-mark { width: 36px; height: 36px; }
        .login-brand-mark img { width: 28px; height: 28px; }
        .login-heading h1 { font-size: 1.3rem; }
        .login-pin-layout, .login-person, .login-pin-layout :global(.digit-pad) { min-height: 330px; }
    }
    @media (max-width: 650px) {
        .login-overlay { place-items: start center; padding: .6rem; }
        .login-form { max-height: none; padding: .85rem; }
        .login-pin-layout { min-height: 0; grid-template-columns: 1fr; }
        .login-person { min-height: 0; }
        .login-person p:not(.login-error) { display: none; }
        .login-error { min-height: 1.2rem; }
        .login-pin-layout :global(.digit-pad) { min-height: 0; }
        .login-pin-layout.back-office { min-height: 0; grid-template-columns: 1fr; }
        .login-pin-layout.back-office .login-person,
        .login-desktop-pin { min-height: 0; }
    }
    .scale-workspace { width: min(1180px, calc(100vw - 2rem)); max-width: 100%; height: min(760px, calc(100dvh - 2rem)); max-height: calc(100dvh - 2rem); overflow: hidden; display: flex; flex-direction: column; border: 1px solid var(--border-flat); border-radius: 1rem; background: var(--bg-base); box-shadow: 0 24px 80px var(--shadow); }
    .scale-header { padding: .75rem 1rem; display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border-flat); background: var(--bg-card); }
    .scale-header h2 { margin: .1rem 0; font-size: 1.55rem; }
    .scale-header p { margin: 0; color: var(--text-muted); font-size: .85rem; }
    .scale-kicker { color: var(--success); font-size: .65rem; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    .scale-close { width: 2.75rem; height: 2.75rem; border-radius: .6rem; }
    .scale-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(300px, .75fr); }
    .scale-products { min-height: 0; padding: .75rem; display: flex; flex-direction: column; gap: .65rem; }
    .scale-page-tabs { display: flex; gap: .4rem; overflow-x: auto; min-height: 44px; padding-bottom: .1rem; }
    .scale-page-tabs button { min-height: 44px; padding: 0 .75rem; display: flex; align-items: center; gap: .4rem; white-space: nowrap; color: var(--text-main); font-size: .75rem; font-weight: 800; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-card); }
    .scale-page-tabs button i { width: .5rem; height: .5rem; border-radius: 50%; background: var(--scale-page-color); }
    .scale-product-grid { min-height: 0; flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(3, minmax(92px, 1fr)); gap: .55rem; }
    .scale-product { position: relative; min-height: 92px; padding: .7rem; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-start; gap: .15rem; color: var(--text-main); text-align: left; border: 2px solid var(--border-flat); border-radius: .7rem; background: var(--bg-card); }
    .scale-product i { position: absolute; z-index: 2; inset: 0 auto 0 0; width: 6px; background: var(--scale-color); }
    .scale-product-photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #fff; }
    .scale-product-shade { position: absolute; inset: 0; background: linear-gradient(to top, rgba(15, 23, 42, .82), rgba(15, 23, 42, .25), rgba(15, 23, 42, .05)); }
    .scale-product-content { position: relative; z-index: 1; display: flex; min-width: 0; flex-direction: column; gap: .12rem; }
    .scale-product strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
    .scale-product span, .scale-product small { color: var(--text-muted); font-size: .75rem; }
    .scale-product.with-image strong, .scale-product.with-image span, .scale-product.with-image small { color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, .45); }
    .scale-product.selected { border-color: var(--success); box-shadow: inset 0 0 0 1px var(--success), 0 0 0 2px color-mix(in srgb, var(--success) 22%, transparent); }
    .scale-product-check { position: absolute; z-index: 3; top: .5rem; right: .5rem; width: 1.65rem; height: 1.65rem; display: grid; place-items: center; color: white !important; border: 2px solid white; border-radius: 50%; background: var(--success); box-shadow: 0 2px 8px rgba(0, 0, 0, .28); }
    .scale-product-check svg { width: 1rem; height: 1rem; }
    .scale-pagination { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: var(--text-muted); font-size: .72rem; }
    .scale-pagination div { display: flex; align-items: center; gap: .4rem; }
    .scale-pagination button { min-height: 44px; padding: 0 .65rem; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-card); color: var(--text-main); font-size: .72rem; font-weight: 800; }
    .scale-pagination button:disabled { opacity: .3; }
    .scale-entry { padding: .7rem; min-height: 0; overflow: hidden; display: grid; grid-template-rows: 72px 44px 64px 66px minmax(190px, 1fr) 52px 48px; gap: .38rem; border-left: 1px solid var(--border-flat); background: var(--bg-panel); }
    .scale-selected, .scale-display, .scale-live, .scale-total { padding: .6rem .7rem; display: flex; flex-direction: column; gap: .1rem; border: 1px solid var(--border-flat); border-radius: .6rem; background: var(--bg-card); }
    .scale-selected span, .scale-display span, .scale-live span, .scale-total span { color: var(--text-muted); font-size: .7rem; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    .scale-selected { min-width: 0; min-height: 0; overflow: hidden; flex-direction: row; align-items: center; justify-content: space-between; gap: .65rem; }
    .scale-selected.has-product { border-color: color-mix(in srgb, var(--success) 55%, var(--border-flat)); }
    .scale-selected-copy { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: .1rem; }
    .scale-selected strong, .scale-selected small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scale-selected strong { line-height: 1.15; }
    .scale-selected small { color: var(--text-muted); line-height: 1.2; }
    .scale-selected-ready { width: 2rem; height: 2rem; flex: 0 0 2rem; display: grid; place-items: center; color: white !important; border-radius: 50%; background: var(--success); }
    .scale-selected-ready svg { width: 1.1rem; height: 1.1rem; }
    .scale-units { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; }
    .scale-units button { min-height: 44px; padding: .48rem; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-card); color: var(--text-main); font-weight: 700; }
    .scale-display strong { font-size: 1.55rem; text-align: right; line-height: 1.1; }
    .scale-display small { font-size: .9rem; color: var(--text-muted); }
    .scale-live { min-height: 0; flex-direction: row; align-items: center; justify-content: space-between; gap: .6rem; }
    .scale-live div { min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
    .scale-live small { color: var(--text-muted); font-size: .74rem; line-height: 1.2; word-break: break-word; }
    .scale-live button { min-height: 44px; padding: 0 .7rem; white-space: nowrap; }
    .scale-numpad { min-height: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(4, minmax(44px, 1fr)); gap: .42rem; }
    .scale-numpad .payment-np-button { min-height: 44px !important; border-radius: .55rem; font-size: 1.28rem !important; }
    .scale-total { margin-top: 0; flex-direction: row; align-items: center; justify-content: space-between; }
    .scale-total strong { color: var(--success); font-size: 1.45rem; }
    .scale-add { min-height: 48px; height: auto; font-size: .95rem; box-shadow: 0 10px 24px var(--shadow); }
    .scale-empty { padding: 2rem; color: var(--text-muted); text-align: center; border: 1px dashed var(--border-flat); border-radius: .8rem; }
    @media (max-width: 880px) { .scale-layout { grid-template-columns: 1fr 310px; } .scale-product-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 1040px) and (max-height: 820px) {
        .scale-workspace { width: min(1180px, calc(100vw - 2rem)); height: calc(100dvh - 2rem); max-height: calc(100dvh - 2rem); }
        .scale-layout { grid-template-columns: minmax(0, 1fr) minmax(270px, .7fr); }
        .scale-entry { padding: .5rem; grid-template-rows: 64px 44px 56px 58px minmax(178px, 1fr) 46px 46px; gap: .35rem; }
        .scale-selected, .scale-display, .scale-live, .scale-total { padding: .45rem .55rem; }
        .scale-product { padding: .55rem; }
        .scale-product span, .scale-product small { font-size: .68rem; }
        .scale-display strong, .scale-total strong { font-size: 1.2rem; }
        .scale-product-grid { grid-template-rows: repeat(3, minmax(78px, 1fr)); }
        .scale-product { min-height: 78px; }
        .scale-live { min-height: 0; }
        .scale-live button { min-height: 44px; padding: 0 .5rem; }
        .scale-numpad { min-height: 0; gap: .32rem; }
        .scale-numpad .payment-np-button { min-height: 44px !important; font-size: 1.15rem !important; }
    }
    @media (max-height: 690px) {
        .scale-workspace { height: calc(100dvh - 2rem); max-height: calc(100dvh - 2rem); }
        .scale-header p, .scale-selected small { display: none; }
        .scale-header { padding: .45rem .8rem; }
        .scale-products { padding: .5rem; gap: .3rem; }
        .scale-entry { padding: .5rem; grid-template-rows: 48px 44px 50px 50px minmax(160px, 1fr) 44px 44px; gap: .3rem; }
        .scale-page-tabs { min-height: 44px; }
        .scale-page-tabs button { min-height: 44px; padding: 0 .55rem; }
        .scale-numpad { min-height: 0; gap: .28rem; }
        .scale-numpad .payment-np-button { min-height: 44px !important; font-size: 1.05rem !important; }
        .scale-add { min-height: 44px; }
    }
    @media (max-width: 760px) {
        .scale-layout { grid-template-columns: 1fr; overflow-y: auto; }
        .scale-products { min-height: 420px; }
        .scale-entry { overflow: visible; border-left: 0; border-top: 1px solid var(--border-flat); }
    }
</style>
