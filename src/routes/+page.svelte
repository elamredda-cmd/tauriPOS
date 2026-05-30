<script lang="ts">
    import { onMount } from "svelte";
    import { get } from "svelte/store";
    import { goto } from "$app/navigation";
    import { playErrorSound, playSuccessSound } from "$lib/sounds";
    import {
        productsDB,
        taxRatesDB,
        activeCategories,
        activePosPages,
        activeProducts,
        storeDB,
        tilesDB,
        ordersDB,
        orderLinesDB,
        paymentsDB,
        heldOrders,
        discountsDB,
        promoGroupsDB,
        promoGroupItemsDB,
        formatMoney,
        toPence,
        toPounds,
        now,
        uuid,
        getProductBySku,
        settingsDB,
        type Order,
    } from "$lib/stores/db";
    import { toast } from "$lib/stores/toast";
    import {
        searchProduct,
        addProduct,
        upsert,
        remove as removeSql,
        getOrCreateTillId,
        getTillName,
        triggerSync,
    } from "$lib/stores/database";
    import { evaluateCart } from "$lib/utils/discountEngine";
    import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
    import CustomSelect from "$lib/components/CustomSelect.svelte";

    let activePageId = "";
    let currentPageIndex = 0;
    let searchQuery = "";
    let hasStartedTypingPrice = false;

    // Cart
    let cart: {
        id: string;
        name: string;
        price: number;
        quantity: number;
        note: string;
    }[] = [];
    let selectedCartIndex = 0;

    let showNumpad = false;
    let numpadValue = "";
    let showChangePricePad = false;
    let changePriceString = "";

    let showGoodsModal = false;
    let goodsPriceString = "0";
    let showMenu = false;
    let showHeldOrders = false;
    let showPaymentModal = false;
    let paymentMethod: "cash" | "card" = "cash";
    let amountTenderedString = "0";
    let hasTypedPayment = false;
    let cartItemEls: HTMLElement[] = [];
    let dynamicQuickAmounts: number[] = [];

    let showNotFoundModal = false;
    let notFoundBarcode = "";
    let showQuickAddModal = false;
    let quickAddName = "";
    let quickAddSku = "";
    let quickAddPrice = "0";
    let quickAddCategoryId = "";
    let quickAddTaxRateId = "";
    let showClearConfirm = false;

    let goodsSearchQuery = "";
    $: filteredGoods = $activeProducts
        .filter((p) => p.showInGoods)
        .sort((a, b) => (a.goodsSortOrder || 0) - (b.goodsSortOrder || 0))
        .slice(0, 10)
        .filter((p) =>
            p.name.toLowerCase().includes(goodsSearchQuery.toLowerCase()),
        );

    let trolleyMessage = "";
    let trolleyMessageType: "info" | "error" | "success" = "info";
    let trolleyMessageTimeout: any;

    $: cartLayout = JSON.parse($settingsDB.find(s => s.key === 'pos_cart_layout')?.value || JSON.stringify(['goods', 'recent_trans', 'change_price', 'drawer']));
    $: toolbarLayout = JSON.parse($settingsDB.find(s => s.key === 'pos_toolbar_layout')?.value || JSON.stringify(['scale', 'drawer', 'discount']));

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

    function updateSetting(key: string, value: string) {
        const s = { key, value, updatedAt: now() };
        settingsDB.update((list) => {
            const idx = list.findIndex((x) => x.key === key);
            if (idx >= 0) {
                list[idx] = s;
            } else {
                list.push(s);
            }
            return list;
        });
        upsert("settings", s, "key");
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
        if ($activePosPages.length > 0 && !activePageId) {
            activePageId = $activePosPages[0].id;
        }
    }

    $: activePageTiles = $tilesDB
        .filter((t) => t.pageId === activePageId)
        .sort((a, b) => a.position - b.position);

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
            product: $activeProducts.find((p) => p.id === tile.productId),
        };
    });

    $: totalItems = cart.reduce((acc, item) => acc + item.quantity, 0);
    $: subtotal = cart.reduce(
        (acc, item) => acc + item.price * item.quantity,
        0,
    );
    $: cartEval = evaluateCart(
        cart.map((c) => ({ id: c.id, price: c.price, quantity: c.quantity })),
        $discountsDB,
        $promoGroupsDB,
        $promoGroupItemsDB,
    );
    $: promoSavings = cartEval.totalSavings;
    $: total = Math.max(0, subtotal - promoSavings);

    let currentTime = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
    });

    function getNextOrderNumber(): number {
        const orders = get(ordersDB);
        // Only count completed orders (not held ones which have orderNumber 0)
        const myCompletedOrders = orders.filter(o => o.tillNumber === tillId && o.orderNumber > 0);
        const nums = myCompletedOrders.map((o) => o.orderNumber);
        
        const settings = get(settingsDB);
        const startSetting = settings.find((s: any) => s.key === 'starting_receipt_number');
        const startNum = startSetting ? parseInt(startSetting.value, 10) || 1 : 1;
        
        const nextFromOrders = nums.length > 0 ? Math.max(...nums) + 1 : 1;
        return Math.max(nextFromOrders, startNum);
    }

    onMount(() => {
        const timer = setInterval(() => {
            currentTime = new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
            });
        }, 60000);

        // Auto-generate and cache till identity for this machine
        getOrCreateTillId().then(id => { tillId = id; });
        getTillName().then(name => { tillName = name; });

        return () => clearInterval(timer);
    });

    let tillId = '';
    let tillName = 'Till 1';

    function moveSelectionUp() {
        if (selectedCartIndex > 0) selectedCartIndex--;
    }
    function moveSelectionDown() {
        if (selectedCartIndex < cart.length - 1) selectedCartIndex++;
    }

    function increaseQty() {
        if (cart[selectedCartIndex]) cart[selectedCartIndex].quantity++;
        cart = [...cart];
    }

    function decreaseQty() {
        if (cart[selectedCartIndex] && cart[selectedCartIndex].quantity > 1) {
            cart[selectedCartIndex].quantity--;
            cart = [...cart];
        }
    }

    function handleNumpadKey(key: string) {
        if (key === "C") {
            numpadValue = "";
        } else if (key === "ENTER") {
            if (numpadValue !== "" && cart[selectedCartIndex]) {
                cart[selectedCartIndex].quantity = parseInt(numpadValue);
                cart = [...cart];
            }
            showNumpad = false;
            numpadValue = "";
        } else {
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
        cart.splice(index, 1);
        cart = [...cart];
        if (selectedCartIndex >= cart.length)
            selectedCartIndex = Math.max(0, cart.length - 1);
    }

    function addToCart(product: { id: string; name: string; price: number }) {
        const existing = cart.findIndex((i) => i.id === product.id);
        if (existing >= 0) {
            cart[existing].quantity++;
            selectedCartIndex = existing;
        } else {
            cart.push({
                id: product.id,
                name: product.name,
                price: product.price,
                quantity: 1,
                note: "",
            });
            selectedCartIndex = cart.length - 1;
        }
        cart = [...cart];
    }

    async function handleSearch() {
        if (!searchQuery.trim()) return;

        // Search in SQLite (Instant even with 78k items)
        const found = await searchProduct(searchQuery);

        if (found) {
            addToCart({
                id: found.id,
                name: found.name,
                price: found.price,
            });
            searchQuery = "";
        } else {
            notFoundBarcode = searchQuery;
            showNotFoundModal = true;
            searchQuery = "";
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
            if (quickAddPrice !== "0") quickAddPrice += "00";
        } else {
            if (quickAddPrice === "0") quickAddPrice = key;
            else quickAddPrice += key;
        }
    }

    function saveQuickProduct() {
        if (!quickAddName.trim()) {
            toast("Item Name is required", "error");
            return;
        }
        if (!quickAddSku.trim()) {
            toast("SKU is required", "error");
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

        productsDB.update((ps) => [...ps, newProduct]);
        addProduct(newProduct); // Also save to SQLite
        addToCart(newProduct);

        showQuickAddModal = false;
        toast("Product added and added to cart", "success");
    }
    function handleSearchKeydown(e: KeyboardEvent) {
        if (e.key === "Enter") handleSearch();
    }

    function confirmClear() {
        cart = [];
        selectedCartIndex = 0;
        showClearConfirm = false;
        showTrolleyFeedback("Cart cleared", "success");
    }

    function holdOrder() {
        if (cart.length === 0) {
            toast("Cart is empty", "error");
            return;
        }
        const orderId = uuid();
        const firstPromoId =
            cartEval.lines
                .flatMap((l) => l.applied)
                .map((a) => a.discountId)[0] || "";
        const newOrder = {
            id: orderId,
            shiftId: "",
            customerId: "",
            employeeId: "emp-admin",
            orderNumber: 0,
            type: "sale" as const,
            status: "hold" as const,
            originalOrderId: "",
            subtotal,
            discountId: firstPromoId,
            discountAmount: promoSavings,
            taxTotal: 0,
            total,
            tillNumber: tillId,
            notes: "",
            createdAt: now(),
            completedAt: "",
        };
        ordersDB.update((orders) => [...orders, newOrder]);
        upsert("orders", newOrder);

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
                isPriceOverride: false,
                originalPrice: item.price,
                notes: item.note,
            };
        });
        orderLinesDB.update((l) => [...l, ...lines]);
        lines.forEach((l) => upsert("order_lines", l));

        cart = [];
        selectedCartIndex = 0;
        toast("Receipt held successfully");
    }

    async function retrieveOrder(orderId: string) {
        if (cart.length > 0) {
            toast(
                "Cannot retrieve while trolley has items. Please clear trolley first.",
                "error",
            );
            return;
        }
        const lines = $orderLinesDB.filter((l) => l.orderId === orderId);
        cart = lines.map((l) => ({
            id: l.productId,
            name: l.productName,
            price: l.unitPrice,
            quantity: l.quantity,
            note: l.notes,
        }));
        selectedCartIndex = 0;
        ordersDB.update((o) => o.filter((x) => x.id !== orderId));
        orderLinesDB.update((l) => l.filter((x) => x.orderId !== orderId));
        // Cascade delete in SQLite (order_lines.orderId has ON DELETE CASCADE).
        try {
            await removeSql("orders", orderId);
        } catch (e) {
            console.error(e);
        }
        showHeldOrders = false;
        toast("Order retrieved");
    }

    function openChangePrice() {
        if (cart[selectedCartIndex]) {
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
            if (changePriceString !== "0") changePriceString += "00";
        } else {
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

    function changePricePermanently() {
        const newPence = parseInt(changePriceString) || 0;
        if (cart[selectedCartIndex]) {
            const updatedItem = { ...cart[selectedCartIndex], price: newPence };
            cart[selectedCartIndex] = updatedItem;

            productsDB.update((items) => {
                const idx = items.findIndex((i) => i.id === updatedItem.id);
                if (idx !== -1) {
                    const updatedProduct = {
                        ...items[idx],
                        price: newPence,
                        updatedAt: now(),
                    };
                    upsert("products", updatedProduct);
                    items[idx] = updatedProduct;
                }
                return [...items];
            });
            cart = [...cart];
        }
        showChangePricePad = false;
        changePriceString = "";
        toast("Price updated permanently");
    }

    function openGoodsModal() {
        goodsPriceString = "0";
        showGoodsModal = true;
    }

    function handleGoodsPadKey(key: string) {
        if (key === "C") {
            goodsPriceString = "0";
        } else if (key === "00") {
            if (goodsPriceString !== "0") goodsPriceString += "00";
        } else {
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

        showGoodsModal = false;
        goodsPriceString = "0";
    }
    $: isMenuDisabled = cart.length > 0 || $heldOrders.length > 0;

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
        goto(path);
    }

    let showRecentTransactions = false;
    let selectedRecentOrderId: string | null = null;
    let recentOrders: any[] = [];

    function openRecentTransactions() {
        recentOrders = $ordersDB
            .filter((o) => o.status !== "hold")
            .sort(
                (a, b) =>
                    new Date(b.completedAt).getTime() -
                    new Date(a.completedAt).getTime(),
            )
            .slice(0, 10);
        selectedRecentOrderId =
            recentOrders.length > 0 ? recentOrders[0].id : null;
        showRecentTransactions = true;
    }

    function printReceipt() {
        toast("Receipt sent to printer!", "success", false);
    }

    async function voidOrder(orderId: string) {
        let voided: any = null;
        ordersDB.update((os) => {
            const next = os.map((o) =>
                o.id === orderId ? { ...o, status: "voided" as const } : o,
            );
            voided = next.find((o) => o.id === orderId);
            return next;
        });
        if (voided) {
            try {
                await upsert("orders", voided);
            } catch (e) {
                console.error(e);
                toast("Failed to persist void", "error");
                return;
            }
        }
        toast("Order voided successfully", "info");
        openRecentTransactions(); // refresh
    }

    async function refundOrder(orderId: string, partial: boolean) {
        let refunded: any = null;
        ordersDB.update((os) => {
            const next = os.map((o) =>
                o.id === orderId
                    ? {
                          ...o,
                          status: (partial
                              ? "partially_refunded"
                              : "refunded") as Order["status"],
                      }
                    : o,
            );
            refunded = next.find((o) => o.id === orderId);
            return next;
        });
        if (refunded) {
            try {
                await upsert("orders", refunded);
            } catch (e) {
                console.error(e);
                toast("Failed to persist refund", "error");
                return;
            }
        }
        toast(
            partial ? "Order partially refunded" : "Order fully refunded",
            "info",
        );
        openRecentTransactions(); // refresh
    }

    let nextPoundAmount: number | null = null;
    const fixedQuickAmounts = [500, 1000, 2000, 5000];

    function calculateQuickAmounts(tPence: number) {
        let nextPound = Math.ceil(tPence / 100) * 100;
        nextPoundAmount = nextPound > tPence ? nextPound : null;
    }

    function openPayment() {
        if (cart.length === 0) {
            toast("Cart is empty", "error");
            return;
        }
        amountTenderedString = "0";
        paymentMethod = "cash";
        hasTypedPayment = false;
        calculateQuickAmounts(total);
        showPaymentModal = true;
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
            } else if (amountTenderedString !== "0")
                amountTenderedString += "00";
        } else {
            if (!hasTypedPayment || amountTenderedString === "0") {
                amountTenderedString = key;
                hasTypedPayment = true;
            } else amountTenderedString += key;
        }
    }

    function setAmountAndComplete(amount: number) {
        amountTenderedString = amount.toString();
        hasTypedPayment = true;
        completeSale();
    }

    function addQuickAmount(amount: number) {
        if (!hasTypedPayment || amountTenderedString === "0") {
            amountTenderedString = "0";
            hasTypedPayment = true;
        }
        amountTenderedString = (
            parseInt(amountTenderedString) + amount
        ).toString();
    }

    function completeSale() {
        const tendered =
            paymentMethod === "cash"
                ? parseInt(amountTenderedString) || 0
                : total;
        if (paymentMethod === "cash" && tendered < total) {
            toast("Amount tendered is less than total", "error");
            return;
        }

        // Determine split amounts
        let cashAmount = 0;
        let cardAmount = 0;
        let change = 0;
        let method: 'cash' | 'card' | 'split' = paymentMethod;

        if (paymentMethod === "cash") {
            cashAmount = total;
            cardAmount = 0;
            change = tendered - total;
        } else if (paymentMethod === "card") {
            // Check if user typed a cash amount less than total (split payment)
            const typedCash = parseInt(amountTenderedString) || 0;
            if (typedCash > 0 && typedCash < total) {
                // Split: part cash, rest on card
                cashAmount = typedCash;
                cardAmount = total - typedCash;
                change = 0;
                method = 'split';
            } else {
                // Full card
                cashAmount = 0;
                cardAmount = total;
                change = 0;
            }
        }

        const orderId = uuid();
        const firstPromoId =
            cartEval.lines
                .flatMap((l) => l.applied)
                .map((a) => a.discountId)[0] || "";
        const newOrder = {
            id: orderId,
            shiftId: "",
            customerId: "",
            employeeId: "emp-admin",
            orderNumber: getNextOrderNumber(),
            type: "sale" as const,
            status: "completed" as const,
            originalOrderId: "",
            subtotal,
            discountId: firstPromoId,
            discountAmount: promoSavings,
            taxTotal: 0,
            total,
            tillNumber: tillId,
            notes: "",
            paymentMethod: method,
            amountTendered: tendered,
            createdAt: now(),
            completedAt: now(),
        };

        ordersDB.update((orders) => [...orders, newOrder]);
        upsert("orders", newOrder);

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
                isPriceOverride: false,
                originalPrice: item.price,
                notes: item.note,
            };
        });

        orderLinesDB.update((l) => [...l, ...lines]);
        lines.forEach((l) => upsert("order_lines", l));

        // Record the payment with split amounts so reports can use them.
        const payment = {
            id: uuid(),
            orderId,
            method,
            amount: total,
            cashAmount,
            cardAmount,
            reference: "",
            changeGiven: paymentMethod === "cash" ? Math.max(0, change) : 0,
            createdAt: now(),
        };
        paymentsDB.update((ps) => [...ps, payment as any]);
        upsert("payments", payment);

        cart = [];
        selectedCartIndex = 0;
        showPaymentModal = false;
        playSuccessSound();

        if (paymentMethod === "cash" && change > 0) {
            toast(
                `Sale completed. Change: ${formatMoney(change)}`,
                "success",
                true,
            );
        } else {
            toast("Sale completed successfully", "success", true);
        }

        // Immediately trigger sync so other tills see this transaction
        triggerSync();
    }
</script>

<div
    class="flex h-screen w-screen overflow-hidden"
    on:click={() => (showMenu = false)}
>
    <!-- Main Content (Products) -->
    <main class="flex-1 flex flex-col p-2 md:p-3 lg:p-5 overflow-hidden">
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
                                on:click={() => handleMenuClick("/tiles")}
                                >🎨 Designer</button
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
                                class="menu-link !text-danger hover:!bg-danger hover:!text-white"
                                >🚪 Logout</button
                            >
                        </div>
                    {/if}
                </div>

                <div class="flex items-center gap-3">
                    <div
                        class="w-10 h-10 bg-accent-primary rounded-full flex items-center justify-center font-serif font-bold text-base text-white"
                    >
                        {$storeDB.name.substring(0, 2).toUpperCase()}
                    </div>
                    <span class="font-semibold text-text-muted">Admin</span>
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
                </div>
            </div>

            <h1 class="absolute left-1/2 -translate-x-1/2 text-xl md:text-2xl lg:text-3xl font-black text-text-main tracking-tight">{$storeDB.name}</h1>
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
                {#each displayTiles as slot}
                    {#if slot && slot.product}
                        <div
                            class="relative overflow-hidden cursor-pointer bg-[var(--tile-bg)] border border-border-flat rounded-md transition-colors hover:brightness-110 flex flex-col"
                            on:click={() => addToCart(slot.product!)}
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
                                            {formatMoney(slot.product.price)}
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
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[10px] md:text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors flex items-center justify-center">SCALE</button>
                    {:else if btn === 'drawer'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[10px] md:text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors flex items-center justify-center">DRAWER</button>
                    {:else if btn === 'discount'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[10px] md:text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors flex items-center justify-center">DISCOUNT</button>
                    {:else if btn === 'goods'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[10px] md:text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors flex items-center justify-center" on:click={openGoodsModal}>GOODS</button>
                    {:else if btn === 'recent_trans'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[8px] md:text-[8px] md:text-[10px] lg:text-xs font-bold leading-tight hover:bg-bg-card-hover transition-colors flex items-center justify-center text-center" on:click={openRecentTransactions}>RECENT<br class="hidden md:inline"/>TRANS</button>
                    {:else if btn === 'change_price'}
                        <button class="h-full flex-1 bg-bg-card border border-border-flat rounded-md text-[8px] md:text-[10px] font-bold leading-tight hover:bg-bg-card-hover transition-colors flex items-center justify-center text-center" on:click={openChangePrice}>CHANGE<br class="hidden md:inline"/>PRICE</button>
                    {/if}
                {/each}
            </div>
        </div>
    </main>

    <!-- Cart / Trolly -->
    <aside
        class="flex flex-col w-64 md:w-72 lg:w-80 xl:w-96 2xl:w-[420px] bg-bg-panel border-l border-border-flat shrink-0 overflow-hidden"
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
                    {#if $heldOrders.length > 0}
                        <button
                            class="bg-warning/20 text-warning text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-warning/30 animate-pulse"
                            on:click|stopPropagation={() =>
                                (showHeldOrders = true)}
                            >{$heldOrders.length} held</button
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
                    type="text"
                    placeholder="Search/Scan..."
                    class="bg-transparent border-none outline-none text-sm text-text-main w-full disabled:opacity-40"
                    bind:value={searchQuery}
                    on:keydown={handleSearchKeydown}
                    disabled={showNotFoundModal}
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
                        {item.quantity}x
                    </div>
                    <div class="flex-1 min-w-0">
                        <h4
                            class="m-0 text-[11px] md:text-sm font-bold text-text-main truncate leading-tight"
                        >
                            {item.name}
                        </h4>
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
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md text-base md:text-lg lg:text-xl font-bold hover:bg-bg-card-hover transition-colors"
                on:click={increaseQty}>+</button
            >
            <button
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md text-base md:text-lg lg:text-xl font-bold hover:bg-bg-card-hover transition-colors"
                on:click={decreaseQty}>-</button
            >
            <button
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md hover:bg-bg-card-hover transition-colors text-text-main"
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
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md hover:bg-bg-card-hover transition-colors text-text-main"
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
                class="flex-1 h-8 md:h-10 lg:h-12 flex items-center justify-center bg-bg-card border border-border-flat rounded-md text-danger hover:bg-danger hover:text-white transition-colors"
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
                class="flex-[2] h-8 md:h-10 lg:h-12 flex items-center justify-center gap-1 md:gap-2 bg-bg-card border border-border-flat rounded-md font-bold text-[10px] md:text-sm hover:bg-bg-card-hover transition-colors"
                on:click={() => (showNumpad = true)}
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
                        class="row-span-2 h-full bg-success text-white text-base md:text-lg font-black rounded-md shadow-lg hover:brightness-110 active:scale-[0.98] transition-all tracking-wider flex items-center justify-center"
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
                        class="h-full bg-bg-card border border-border-flat rounded-md font-bold text-xs hover:bg-bg-card-hover transition-colors leading-tight"
                        on:click={openChangePrice}>CHANGE<br/>PRICE</button
                    >
                {:else if btn === 'drawer'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        >DRAWER</button
                    >
                {:else if btn === 'scale'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        >SCALE</button
                    >
                {:else if btn === 'discount'}
                    <button
                        class="h-full bg-bg-card border border-border-flat rounded-md text-[9px] md:text-xs lg:text-sm font-bold hover:bg-bg-card-hover transition-colors"
                        >DISCOUNT</button
                    >
                {/if}
            {/each}
        </div>
    </aside>
</div>

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
    <div class="modal-overlay" on:click={() => (showPaymentModal = false)}>
        <div
            class="w-[800px] max-w-[95vw] max-h-[85vh] md:max-h-[95vh] overflow-y-auto p-3 md:p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-5"
            on:click|stopPropagation
        >
            <div
                class="flex justify-between items-center border-b border-border-flat pb-4"
            >
                <h2 class="m-0 text-text-main text-xl md:text-[1.5rem]">Payment</h2>
                <button
                    class="modal-close"
                    on:click={() => (showPaymentModal = false)}>✕</button
                >
            </div>

            <div class="flex flex-col md:flex-row gap-4 md:gap-6">
                <div class="flex-1 flex flex-col gap-5">
                    <div
                        class="flex justify-between items-center p-5 bg-bg-panel rounded-sm border border-border-flat"
                    >
                        <span class="text-base md:text-[1.2rem] text-text-muted"
                            >Total to Pay</span
                        >
                        <span class="text-3xl md:text-[2.2rem] font-bold text-success"
                            >{formatMoney(total)}</span
                        >
                    </div>

                    <div class="flex gap-3">
                        <button
                            class="flat-card flex-1 p-3 md:p-5 text-base md:text-[1.2rem] font-semibold cursor-pointer flex justify-center items-center gap-2 {paymentMethod ===
                            'cash'
                                ? '!bg-accent-primary !text-white !border-accent-primary'
                                : ''}"
                            on:click={() => (paymentMethod = "cash")}
                            >💵 Cash</button
                        >
                        <button
                            class="flat-card flex-1 p-3 md:p-5 text-base md:text-[1.2rem] font-semibold cursor-pointer flex justify-center items-center gap-2 {paymentMethod ===
                            'card'
                                ? '!bg-accent-primary !text-white !border-accent-primary'
                                : ''}"
                            on:click={() => (paymentMethod = "card")}
                            >💳 Card</button
                        >
                    </div>

                    <div class="flex-1"></div>

                    <div class="flex flex-col gap-3 mt-auto">
                        {#if paymentMethod === "cash"}
                            {#if parseInt(amountTenderedString) >= total}
                                <div
                                    class="text-center text-xl md:text-[1.5rem] font-bold text-warning p-2 md:p-3 bg-bg-panel rounded-sm"
                                >
                                    Change: {formatMoney(
                                        parseInt(amountTenderedString) - total,
                                    )}
                                </div>
                            {:else if parseInt(amountTenderedString) > 0}
                                <div
                                    class="text-center text-xl md:text-[1.5rem] font-bold text-danger p-2 md:p-3 bg-bg-panel rounded-sm"
                                >
                                    Remaining: {formatMoney(
                                        total - parseInt(amountTenderedString),
                                    )}
                                </div>
                            {:else}
                                <div
                                    class="text-center text-[1.5rem] font-bold text-warning p-3 bg-bg-panel rounded-sm invisible"
                                >
                                    Change: £0.00
                                </div>
                            {/if}
                        {:else if parseInt(amountTenderedString) > 0 && parseInt(amountTenderedString) < total}
                            <div
                                class="text-center text-[1.5rem] font-bold text-warning p-3 bg-bg-panel rounded-sm"
                            >
                                Card Payment: {formatMoney(
                                    total - parseInt(amountTenderedString),
                                )}
                            </div>
                        {:else}
                            <div
                                class="text-center text-[1.5rem] font-bold text-warning p-3 bg-bg-panel rounded-sm invisible"
                            >
                                Change: £0.00
                            </div>
                        {/if}
                        <button
                            class="btn btn-success w-full p-3 md:p-5 text-lg md:text-[1.4rem] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                            disabled={paymentMethod === 'cash' && (parseInt(amountTenderedString) || 0) < total}
                            on:click={completeSale}
                        >
                            Complete Sale
                        </button>
                    </div>
                </div>

                <div
                    class="w-full md:w-[340px] flex flex-col bg-bg-panel p-3 md:p-4 rounded-md {paymentMethod ===
                        'card' && parseInt(amountTenderedString) === 0
                        ? 'opacity-50 pointer-events-none'
                        : ''}"
                >
                    <div class="flex gap-3 mb-3">
                        <div class="np-display flex-1 !h-12 md:!h-[60px] !text-2xl md:!text-[2rem]">
                            {formatMoney(parseInt(amountTenderedString || "0"))}
                        </div>
                        <button
                            class="np-btn np-clear w-[50px] md:w-[60px] !h-12 md:!h-[60px]"
                            on:click={() => handlePaymentPadKey("C")}>C</button
                        >
                    </div>
                    <div class="np-grid">
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
                            on:click={() => setAmountAndComplete(total)}
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
                                    Chg: {formatMoney(nextPoundAmount - total)}
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
                <h3>Held Orders ({$heldOrders.length})</h3>
                <button
                    class="modal-close"
                    on:click={() => (showHeldOrders = false)}>✕</button
                >
            </div>
            <div class="overflow-y-auto flex flex-col gap-2">
                {#each $heldOrders as ho}
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
                                    >{l.quantity}x {l.productName}</span
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
                {#if $heldOrders.length === 0}<p
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
                                    ).toLocaleTimeString("en-GB", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                    })}</span
                                >
                            </div>
                            <div
                                class="font-bold text-[1.2rem] text-right {ro.status ===
                                'completed'
                                    ? 'text-success'
                                    : 'text-warning'}"
                            >
                                {formatMoney(ro.total)}
                                <div class="text-[0.75rem]">{ro.status}</div>
                            </div>
                        </button>
                    {/each}
                    {#if recentOrders.length === 0}
                        <p class="text-center text-text-muted p-5">
                            No recent transactions
                        </p>
                    {/if}
                </div>

                <div class="flex-1 flex flex-col gap-3 min-h-[350px] md:min-h-0">
                    {#if selectedRecentOrderId}
                        {@const selectedOrder = recentOrders.find(
                            (o) => o.id === selectedRecentOrderId,
                        )}
                        <div class="receipt-paper">
                            <div class="text-center">
                                <h3 class="m-0 text-[1.1rem] font-bold">
                                    {$storeDB.name}
                                </h3>
                                <p class="m-0">{$storeDB.address}</p>
                                <p class="m-0">{$storeDB.phone}</p>
                                <div class="receipt-divider">
                                    --------------------------------
                                </div>
                                <p class="m-0 text-left">
                                    Receipt: #{selectedOrder?.orderNumber || '—'}
                                </p>
                                <p class="m-0 text-left">
                                    Date: {new Date(
                                        selectedOrder?.completedAt,
                                    ).toLocaleString("en-GB")}
                                </p>
                                <p class="m-0 text-left">
                                    Cashier: {selectedOrder?.employeeId}
                                </p>
                                <p class="m-0 text-left">
                                    Status: {(
                                        selectedOrder?.status || "unknown"
                                    ).toUpperCase()}
                                </p>
                                <div class="receipt-divider">
                                    --------------------------------
                                </div>
                            </div>
                            <table class="w-full">
                                {#each $orderLinesDB.filter((l) => l.orderId === selectedRecentOrderId) as line}
                                    <tr>
                                        <td class="w-[30px]"
                                            >{line.quantity}x</td
                                        >
                                        <td>{line.productName}</td>
                                        <td class="text-right whitespace-nowrap"
                                            >{formatMoney(
                                                line.unitPrice * line.quantity,
                                            )}</td
                                        >
                                    </tr>
                                {/each}
                            </table>
                            <div class="receipt-divider">
                                --------------------------------
                            </div>
                            <div class="flex flex-col gap-1">
                                {#if selectedOrder && (selectedOrder.discountAmount || 0) > 0}
                                    <div class="receipt-row">
                                        <span>Subtotal</span><span
                                            >{formatMoney(
                                                selectedOrder.subtotal || 0,
                                            )}</span
                                        >
                                    </div>
                                    <div class="receipt-row">
                                        <span>Promotion</span><span
                                            >−{formatMoney(
                                                selectedOrder.discountAmount ||
                                                    0,
                                            )}</span
                                        >
                                    </div>
                                {/if}
                                <div class="receipt-row font-bold text-[1rem]">
                                    <span>Total</span><span
                                        >{formatMoney(
                                            selectedOrder?.total || 0,
                                        )}</span
                                    >
                                </div>
                                <div class="receipt-row">
                                    <span
                                        >{(
                                            selectedOrder?.paymentMethod ||
                                            "cash"
                                        ).toUpperCase()}</span
                                    >
                                    <span
                                        >{formatMoney(
                                            selectedOrder?.amountTendered ||
                                                selectedOrder?.total ||
                                                0,
                                        )}</span
                                    >
                                </div>
                                {#if selectedOrder && (selectedOrder.amountTendered || 0) > selectedOrder.total}
                                    <div class="receipt-row">
                                        <span>Change</span><span
                                            >{formatMoney(
                                                (selectedOrder.amountTendered ||
                                                    0) - selectedOrder.total,
                                            )}</span
                                        >
                                    </div>
                                {/if}
                            </div>
                            <div class="receipt-divider">
                                --------------------------------
                            </div>
                            <div class="text-center">
                                <p class="m-0">Thank you for your visit!</p>
                                <div class="text-[1.5rem] tracking-widest mt-2">
                                    ||| |||| | || |||
                                </div>
                            </div>
                        </div>

                        <div class="flex flex-col gap-2">
                            <button
                                class="btn btn-primary w-full"
                                on:click={printReceipt}>Print Receipt</button
                            >
                            {#if selectedOrder && selectedOrder.status === "completed"}
                                <div class="flex gap-2">
                                    <button
                                        class="btn flex-1 !text-warning"
                                        on:click={() =>
                                            refundOrder(selectedOrder.id, true)}
                                        >Partial Ref</button
                                    >
                                    <button
                                        class="btn flex-1 !text-warning"
                                        on:click={() =>
                                            refundOrder(
                                                selectedOrder.id,
                                                false,
                                            )}>Refund</button
                                    >
                                    <button
                                        class="btn flex-1 !text-danger"
                                        on:click={() =>
                                            voidOrder(selectedOrder.id)}
                                        >Void</button
                                    >
                                </div>
                            {/if}
                        </div>
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
            class="w-[400px] max-w-[95vw] max-h-[90vh] overflow-y-auto p-4 sm:p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-4"
            on:click|stopPropagation
        >
            <div class="modal-header">
                <h3>Quick Add Product</h3>
                <button
                    class="modal-close"
                    on:click={() => (showQuickAddModal = false)}>✕</button
                >
            </div>

            <div class="flex flex-col gap-4">
                <div class="input-group">
                    <label for="qa-name">Product Name *</label>
                    <input
                        id="qa-name"
                        type="text"
                        bind:value={quickAddName}
                        placeholder="Enter name..."
                        class="flat-input"
                        autofocus
                    />
                </div>

                <div class="input-group">
                    <label for="qa-sku">SKU *</label>
                    <input
                        id="qa-sku"
                        type="text"
                        bind:value={quickAddSku}
                        placeholder="Enter SKU..."
                        class="flat-input"
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

                <div class="flex flex-col gap-2">
                    <label class="text-[0.9rem] font-semibold text-text-muted"
                        >Price</label
                    >
                    <div class="np-display">
                        {formatMoney(parseInt(quickAddPrice) || 0)}
                    </div>
                    <div class="np-grid">
                        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "00"] as key}
                            <button
                                class="np-btn {key === 'C' ? 'np-clear' : ''}"
                                on:click={() => handleQuickAddPriceKey(key)}
                            >
                                {key}
                            </button>
                        {/each}
                    </div>
                </div>

                <button
                    class="btn btn-success w-full h-[60px] text-[1.2rem] mt-2"
                    on:click={saveQuickProduct}
                >
                    Save & Add to Cart
                </button>
            </div>
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
