(function () {
    'use strict';

    const BACKGROUND_REFRESH_MS = 2500;
    const state = { view: 'overview', summary: null, cache: {}, page: 1, search: '', status: '', action: null, loadId: 0 };
    let backgroundRefreshTimer = null;
    let backgroundRefreshInFlight = false;
    const $ = selector => document.querySelector(selector);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const money = value => `GHS ${Number(value || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const date = value => value ? new Date(value).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
    const shortDate = value => value ? new Date(value).toLocaleDateString('en-GH', { day: '2-digit', month: 'short' }) : '—';
    const status = value => `<span class="status ${escape(String(value || 'unknown'))}">${escape(String(value || 'unknown').replaceAll('_', ' '))}</span>`;
    const initials = value => String(value || 'A').trim().split(/\s+/).map(item => item[0]).join('').slice(0, 2).toUpperCase();

    async function api(path, options = {}) {
        const response = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Request failed.');
        return data;
    }

    function toast(message) {
        const element = $('#toast'); element.textContent = message; element.classList.add('show');
        window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => element.classList.remove('show'), 3200);
    }

    function setIcons() { window.lucide?.createIcons?.(); }

    function showLogin(message = '') {
        stopBackgroundRefresh();
        $('#adminLogin').classList.remove('is-hidden'); $('#adminApp').classList.add('is-hidden'); $('#loginError').textContent = message;
    }

    function showApp(admin) {
        $('#adminLogin').classList.add('is-hidden'); $('#adminApp').classList.remove('is-hidden');
        $('#sidebarAdmin').textContent = admin?.email || 'Admin'; $('#sidebarAdmin').title = admin?.email || 'Admin';
        $('#adminApp').dataset.adminEmail = admin?.email || '';
        state.view = 'overview'; state.page = 1; state.search = ''; state.status = '';
        startBackgroundRefresh();
        loadView('overview');
    }

    function nav(view) {
        state.view = view; state.page = 1; state.search = ''; state.status = '';
        document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
        $('#sidebar').classList.remove('open'); loadView(view);
    }

    function pageHeading(title, copy, actions = '') { return `<div class="page-heading"><div><h1>${escape(title)}</h1><p>${escape(copy)}</p></div><div class="heading-actions">${actions}</div></div>`; }
    function toolbar(placeholder, filters = '') { return `<div class="toolbar"><input class="search" id="viewSearch" value="${escape(state.search)}" placeholder="${escape(placeholder)}" /><div class="toolbar-controls">${filters}<button class="secondary-button" id="applyFilters">Search</button></div></div>`; }
    function panel(title, content, extra = '') { return `<section class="panel ${extra}"><div class="panel-heading"><h3>${escape(title)}</h3></div>${content}</section>`; }
    function metric(label, value, icon, meta) { return `<article class="metric-card"><div class="metric-top"><span>${escape(label)}</span><span class="metric-icon"><i data-lucide="${icon}"></i></span></div><div class="metric-value">${escape(value)}</div><div class="metric-meta">${escape(meta || '')}</div></article>`; }
    function pagination(data) { return `<div class="pagination"><span>${data.total ? `${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} of ${data.total}` : 'No records'}</span><div class="pagination-actions"><button class="tiny-button" data-page="prev" ${data.page <= 1 ? 'disabled' : ''}>Previous</button><button class="tiny-button" data-page="next" ${data.page >= data.pages ? 'disabled' : ''}>Next</button></div></div>`; }
    function table(headers, rows, empty = 'No records found.') { return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}"><div class="empty"><strong>${escape(empty)}</strong><span>Try changing your filters.</span></div></td></tr>`}</tbody></table></div>`; }
    function rowClick(id, type) { return `data-detail-type="${escape(type)}" data-detail-id="${escape(id)}"`; }

    async function loadView(view, { silent = false } = {}) {
        const loadId = ++state.loadId;
        const titles = { overview: 'Overview', users: 'Users', cards: 'Cards', purchases: 'Purchases', deposits: 'Deposits', transactions: 'Transactions', withdrawals: 'Withdrawals', reconciliation: 'Payment Reconciliation', kyc: 'KYC Review', redemptions: 'Redemptions', audit: 'Audit Logs', settings: 'Settings' };
        $('#pageTitle').textContent = titles[view] || 'Overview';
        if (!silent) $('#pageContent').innerHTML = `<div class="panel"><div class="empty">Loading ${escape(titles[view] || 'view')}…</div></div>`;
        try {
            if (view === 'overview') state.summary = await api('/api/admin/summary');
            else {
                const endpoint = { users: '/api/admin/users', cards: '/api/admin/cards', purchases: '/api/admin/purchases', deposits: '/api/admin/deposits', transactions: '/api/admin/transactions', withdrawals: '/api/admin/withdrawals', kyc: '/api/admin/kyc', redemptions: '/api/admin/redemptions', audit: '/api/admin/audit-logs' }[view];
                if (endpoint) state.cache[view] = await api(`${endpoint}?page=${state.page}&pageSize=25&search=${encodeURIComponent(state.search)}&status=${encodeURIComponent(state.status)}`);
            }
            if (loadId !== state.loadId || view !== state.view) return;
            render(view); setIcons(); updateBadges();
        } catch (error) {
            if (loadId !== state.loadId || view !== state.view) return;
            if (error.message.toLowerCase().includes('authentication')) return showLogin('Your admin session expired. Please sign in again.');
            if (!silent) $('#pageContent').innerHTML = `<div class="panel"><div class="empty"><strong>Could not load this view</strong><span>${escape(error.message)}</span></div></div>`;
        }
    }

    function stopBackgroundRefresh() {
        if (backgroundRefreshTimer) window.clearInterval(backgroundRefreshTimer);
        backgroundRefreshTimer = null;
    }

    function startBackgroundRefresh() {
        stopBackgroundRefresh();
        backgroundRefreshTimer = window.setInterval(refreshInBackground, BACKGROUND_REFRESH_MS);
    }

    async function refreshInBackground() {
        if (document.hidden || backgroundRefreshInFlight || $('#adminApp').classList.contains('is-hidden')) return;
        const activeElement = document.activeElement;
        if (activeElement?.matches('input, textarea, select') || ($('#settingsSave') && !$('#settingsSave').disabled) || $('#actionModal').classList.contains('open') || $('#detailDrawer').classList.contains('open')) return;
        backgroundRefreshInFlight = true;
        try { await loadView(state.view, { silent: true }); } finally { backgroundRefreshInFlight = false; }
    }

    // Pull to refresh — same Snapchat-style drag-down gesture as the customer
    // app, reloading whatever admin view is currently open.
    function initPullToRefresh() {
        const indicator = $('#ptrIndicator');
        if (!indicator || !('ontouchstart' in window || navigator.maxTouchPoints > 0)) return;
        const THRESHOLD = 68;
        const MAX_PULL = 96;
        const RESIST = 1.9;
        let startY = 0;
        let pulling = false;
        let dragging = false;
        let refreshing = false;
        let pullDistance = 0;

        const canPull = () => !refreshing
            && !$('#adminApp').classList.contains('is-hidden')
            && window.scrollY <= 0
            && !document.activeElement?.matches('input, textarea, select')
            && !$('#sidebar').classList.contains('open')
            && !$('#overlay').classList.contains('open')
            && !$('#detailDrawer').classList.contains('open')
            && !$('#actionModal').classList.contains('open');

        const setIndicator = distance => {
            indicator.classList.add('ptr-visible');
            indicator.classList.remove('ptr-animate');
            const travel = Math.min(distance, MAX_PULL);
            indicator.style.transform = `translateY(${-58 + travel}px)`;
            const spins = Math.min(distance / THRESHOLD, 1) * 360;
            indicator.querySelector('svg').style.transform = `rotate(${spins}deg)`;
        };

        const reset = () => {
            indicator.classList.add('ptr-animate');
            indicator.classList.remove('ptr-visible', 'ptr-loading');
            indicator.style.transform = 'translateY(-58px)';
        };

        document.addEventListener('touchstart', event => {
            if (!canPull() || event.touches.length !== 1) { dragging = false; return; }
            startY = event.touches[0].clientY;
            dragging = true;
            pulling = false;
            pullDistance = 0;
        }, { passive: true });

        document.addEventListener('touchmove', event => {
            if (!dragging || refreshing) return;
            const delta = event.touches[0].clientY - startY;
            if (delta <= 0 || window.scrollY > 0) { pulling = false; return; }
            pulling = true;
            event.preventDefault();
            pullDistance = delta / RESIST;
            setIndicator(pullDistance);
        }, { passive: false });

        document.addEventListener('touchend', async () => {
            if (!dragging) return;
            dragging = false;
            if (!pulling) return;
            pulling = false;
            if (pullDistance >= THRESHOLD) {
                refreshing = true;
                indicator.classList.add('ptr-animate', 'ptr-loading', 'ptr-visible');
                indicator.style.transform = `translateY(${-58 + Math.min(THRESHOLD, MAX_PULL)}px)`;
                try {
                    await loadView(state.view);
                } catch (e) {
                    toast(e.message || 'Could not refresh right now.');
                } finally {
                    refreshing = false;
                    indicator.classList.remove('ptr-loading');
                    reset();
                }
            } else {
                reset();
            }
        }, { passive: true });

        document.addEventListener('touchcancel', () => { dragging = false; pulling = false; reset(); }, { passive: true });
    }

    function updateBadges() {
        const summary = state.summary; if (!summary) return;
        $('#withdrawalCount').textContent = summary.metrics.pendingWithdrawals || '';
        $('#kycCount').textContent = summary.metrics.pendingKyc || '';
    }

    function render(view) {
        const renderers = { overview: renderOverview, users: renderUsers, cards: renderCards, purchases: renderPurchases, deposits: renderDeposits, transactions: renderTransactions, withdrawals: renderWithdrawals, kyc: renderKyc, redemptions: renderRedemptions, audit: renderAudit, settings: renderSettings, reconciliation: renderReconciliation };
        $('#pageContent').innerHTML = renderers[view] ? renderers[view]() : renderOverview();
    }

    function trendLineChart(trend) {
        const width = 700, height = 200, padX = 12, padTop = 12, padBottom = 12, plotH = height - padTop - padBottom;
        const n = Math.max(1, trend.length);
        const stepX = n > 1 ? (width - padX * 2) / (n - 1) : 0;
        const usersVals = trend.map(item => item.users);
        const spentVals = trend.map(item => item.spent);
        const usersMax = Math.max(1, ...usersVals), usersMin = Math.min(...usersVals, 0);
        const spentMax = Math.max(1, ...spentVals);
        const yFor = (value, max, min) => { const range = Math.max(1, max - min); return padTop + plotH - ((value - min) / range) * plotH; };
        const xFor = (i) => padX + i * stepX;
        const pointsFor = (vals, max, min) => vals.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v, max, min).toFixed(1)}`).join(' ');
        const dotsFor = (vals, max, min, cls, label, fmt) => vals.map((v, i) => `<circle class="trend-dot ${cls}" cx="${xFor(i).toFixed(1)}" cy="${yFor(v, max, min).toFixed(1)}" r="3"><title>${escape(shortDate(trend[i].date))} · ${label} ${fmt(v)}</title></circle>`).join('');
        return `<div class="trend-chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="trend-svg">
            <polyline class="trend-line users" points="${pointsFor(usersVals, usersMax, usersMin)}" />
            <polyline class="trend-line spent" points="${pointsFor(spentVals, spentMax, 0)}" />
            ${dotsFor(usersVals, usersMax, usersMin, 'users', 'Users', v => v.toLocaleString())}
            ${dotsFor(spentVals, spentMax, 0, 'spent', 'Spent', money)}
        </svg></div><div class="trend-labels">${trend.map(item => `<span>${escape(shortDate(item.date))}</span>`).join('')}</div>`;
    }

    function renderOverview() {
        const data = state.summary; const m = data.metrics;
        const chart = trendLineChart(data.trend);
        return pageHeading('Overview', 'Mission control for marketplace, money movement, and verification.') + `<div class="metric-grid">${metric('Users', m.users, 'users', 'Registered accounts')}${metric('Active cards', m.activeCards, 'layers-3', `${m.stockUnits.toLocaleString()} aggregate stock units`)}${metric('Pending withdrawals', m.pendingWithdrawals, 'landmark', 'Requires review')}${metric('Pending KYC', m.pendingKyc, 'shield-check', `${m.pendingPayments} payment sessions pending${m.paymentsNeedingReview ? ` · ${m.paymentsNeedingReview} paid card(s) need a refund review` : ''}`)}</div><div class="dashboard-grid"><div>${panel('Users & spend', `${chart}<div class="legend"><span><i></i>Users</span><span><i class="spent"></i>Spent (cards + KYC)</span></div>`)}${panel('Financial totals', `<div class="detail-grid"><div class="detail-cell"><span>Wallet deposits</span><strong>${money(m.walletDepositVolume)}</strong></div><div class="detail-cell"><span>Card purchases</span><strong>${money(m.purchaseVolume)}</strong></div><div class="detail-cell"><span>Redemption credits</span><strong>${money(m.redemptionVolume)}</strong></div><div class="detail-cell"><span>Withdrawal requests</span><strong>${money(m.withdrawalVolume)}</strong></div></div>`, 'mt-16')}</div><div>${panel('Needs attention', `<div class="attention-list"><div class="attention-item" data-go="withdrawals"><i data-lucide="landmark"></i><div><strong>Withdrawals awaiting review</strong><span>Open the withdrawal queue</span></div><b class="attention-count">${m.pendingWithdrawals}</b></div><div class="attention-item" data-go="kyc"><i data-lucide="shield-check"></i><div><strong>KYC submissions awaiting review</strong><span>Review identity documents</span></div><b class="attention-count">${m.pendingKyc}</b></div><div class="attention-item" data-go="deposits"><i data-lucide="arrow-down-to-line"></i><div><strong>Payment sessions to reconcile</strong><span>Compare Site A references</span></div><b class="attention-count">${m.pendingPayments}</b></div></div>`)}${panel('Recent activity', `<div class="attention-list">${data.recent.transactions.slice(0, 5).map(item => `<div class="attention-item" ${rowClick(item.id, 'transaction')}><i data-lucide="receipt-text"></i><div><strong>${escape(item.reason)}</strong><span>${escape(item.userName)} · ${escape(item.reference)}</span></div><b class="amount">${money(item.amount)}</b></div>`).join('') || '<div class="empty">No activity yet.</div>'}</div>`, 'mt-16')}</div></div>`;
    }

    function renderUsers() { const data = state.cache.users; const rows = data.items.map(item => `<tr ${rowClick(item.id, 'user')}><td><strong>${escape(item.name)}</strong><small>${escape(item.id)} · ${escape(item.email || item.phone)}</small></td><td class="amount">${money(item.walletBalance)}</td><td class="amount">${money(item.redeemedBalance)}</td><td>${status(item.kycStatus)}</td><td>${item.blocked ? status('blocked') : '—'}</td><td>${escape(item.purchaseCount)} purchases<small>${escape(item.redemptionCount)} redemptions</small></td><td>${shortDate(item.createdAt)}</td><td><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="tiny-button${item.canBuyWithBalance ? ' active' : ''}" data-toggle-balance="${escape(item.id)}" data-enabled="${item.canBuyWithBalance ? '1' : '0'}" title="Let this user buy cards with their redeemed balance">${item.canBuyWithBalance ? 'Balance buying: ON' : 'Allow balance buying'}</button>${item.blocked ? `<button class="tiny-button" data-action="unblock-user" data-id="${escape(item.id)}">Unblock</button>` : `<button class="tiny-button danger" data-action="block-user" data-id="${escape(item.id)}">Block</button>`}</div></td></tr>`).join(''); return pageHeading('Users', 'Customer accounts, balances, verification, and activity.') + toolbar('Search name, email, phone, or ID…', `<select id="statusFilter"><option value="">All KYC states</option><option value="PENDING">Pending</option><option value="VERIFIED">Verified</option><option value="REJECTED">Rejected</option><option value="NOT_VERIFIED">Not verified</option></select>`) + `<section class="panel table-panel">${table(['User', 'Wallet Balance', 'Redeemed Balance', 'KYC', 'Account', 'Activity', 'Joined', 'Actions'], rows, 'No users found.')}${pagination(data)}</section>`; }
    function renderCards() { const data = state.cache.cards; const rows = data.items.map(item => `<tr ${rowClick(item.id, 'card')}><td><strong>${escape(item.title)}</strong><small>${escape(item.id)} · ${escape(item.series)}</small></td><td>${escape(item.category)}</td><td>${escape(item.displayPriceUsd)} USD</td><td class="amount">${money(item.priceGhs)}</td><td class="amount">${escape(item.stock)}</td><td>${status(item.active ? 'active' : 'out of stock')}</td><td>${escape(item.rewardMinRate)}×–${escape(item.rewardMaxRate)}×<small>${escape(item.purchaseCount)} purchases · ${escape(item.redeemedCount)} redeemed</small></td></tr>`).join(''); return pageHeading('Cards', 'Catalog and aggregate inventory visibility.') + toolbar('Search card, category, series, or ID…') + `<section class="panel table-panel">${table(['Card', 'Category', 'USD price', 'GHS price', 'Stock', 'State', 'Reward range'], rows, 'No cards found.')}${pagination(data)}</section>`; }
    function renderPurchases() { const data = state.cache.purchases; const rows = data.items.map(item => `<tr ${rowClick(item.id, 'purchase')}><td><strong>${escape(item.orderId)}</strong><small>${escape(item.reference)}</small></td><td>${escape(item.userName)}<small>${escape(item.userEmail || item.userId)}</small></td><td>${escape(item.cardTitle)}<small>${escape(item.cardCategory)}</small></td><td class="amount">${money(item.amountPaid ?? item.amount)}</td><td>${status(item.codeStatus)}</td><td>${shortDate(item.createdAt)}</td></tr>`).join(''); return pageHeading('Purchases', 'Read-only order and redemption linkage.') + toolbar('Search order, reference, user, or card…') + `<section class="panel table-panel">${table(['Purchase', 'User', 'Card', 'Wallet debit', 'Code state', 'Purchased'], rows, 'No purchases found.')}${pagination(data)}</section>`; }
    function renderDeposits() { const data = state.cache.deposits; const rows = data.items.map(item => `<tr ${rowClick(item.transactionId || item.id, 'deposit')}><td><strong>${escape(item.transactionId || item.id)}</strong><small>${escape(item.reference)}</small></td><td>${escape(item.userName)}<small>${escape(item.userEmail || item.userId)}</small></td><td class="amount">${money(item.amount)}</td><td>${status(item.status)}</td><td><strong>${escape(item.paystackReference || '—')}</strong></td><td>${shortDate(item.createdAt)}</td></tr>`).join(''); return pageHeading('Deposits', 'Wallet top-ups and external payment references.') + toolbar('Search deposit, user, Paystack reference…', `<select id="statusFilter"><option value="">All statuses</option><option value="SUCCESS">Success</option><option value="PENDING">Pending</option><option value="PAYMENT_INITIALIZED">Initialized</option><option value="FAILED">Failed</option><option value="EXPIRED">Expired</option></select>`) + `<section class="panel table-panel">${table(['Site A deposit', 'User', 'Amount', 'Status', 'External references', 'Created'], rows, 'No deposits found.')}${pagination(data)}</section>`; }
    function renderRedemptions() { const data = state.cache.redemptions; const rows = data.items.map(item => `<tr ${rowClick(item.id, 'redemption')}><td>${escape(item.userName)}<small>${escape(item.userId)}</small></td><td><strong>${escape(item.cardTitle)}</strong><small>${escape(item.orderId)}</small></td><td class="amount">${money(item.rewardAmount)}</td><td>${escape(item.redemptionReference || '—')}</td><td>${shortDate(item.redeemedAt)}</td></tr>`).join(''); return pageHeading('Redemptions', 'Inspect code ownership, reward credits, and references.') + toolbar('Search user, card, order, or redemption reference…') + `<section class="panel table-panel">${table(['User', 'Card', 'Redeemed amount', 'Reference', 'Redeemed'], rows, 'No redemptions found.')}${pagination(data)}</section>`; }
    function renderWithdrawals() { const data = state.cache.withdrawals; const rows = data.items.map(item => `<tr ${rowClick(item.reference, 'withdrawal')}><td><strong>${escape(item.userName)}</strong><small>${escape(item.reference)}</small></td><td class="amount">${money(item.requestedAmount)}</td><td class="amount">${money(item.operationalCharge)}<small>Payout ${money(item.actualAmount)}</small></td><td>${escape(item.method?.network || '—')}<small>${escape(item.method?.phone || '')}</small></td><td>${status(item.userKycStatus)}</td><td>${status(item.status)}</td><td>${item.status === 'pending' ? `<div class="row-actions"><button class="tiny-button" data-action="approve" data-id="${escape(item.reference)}">Approve</button><button class="tiny-button danger" data-action="reject" data-id="${escape(item.reference)}">Reject</button></div>` : '—'}</td></tr>`).join(''); return pageHeading('Withdrawals', 'Review requested amount, charges, KYC, and payout state.') + toolbar('Search withdrawal, user, method, or reference…', `<select id="statusFilter"><option value="">All statuses</option><option value="pending">Needs review</option><option value="PENDING_KYC_VERIFICATION">KYC pending</option><option value="approved">Approved</option><option value="completed">Completed</option><option value="rejected">Rejected</option></select>`) + `<section class="panel table-panel">${table(['User / reference', 'Requested', 'Charge / payout', 'Method', 'KYC', 'Status', 'Actions'], rows, 'No withdrawals found.')}${pagination(data)}</section>`; }
    function renderKyc() { const data = state.cache.kyc; const rows = data.items.map(item => `<tr ${rowClick(item.id, 'kyc')}><td><strong>${escape(item.name)}</strong><small>${escape(item.id)} · ${escape(item.email || item.phone)}</small></td><td>${escape(item.documents?.length || 0)} documents</td><td>${shortDate(item.kycSubmittedAt || item.createdAt)}</td><td>${status(item.kycStatus)}</td><td>${item.kycStatus === 'PENDING' ? `<div class="row-actions"><button class="tiny-button" data-action="verify-kyc" data-id="${escape(item.id)}">Verify</button><button class="tiny-button danger" data-action="reject-kyc" data-id="${escape(item.id)}">Reject</button></div>` : '—'}</td></tr>`).join(''); return pageHeading('KYC review', 'Review submitted identity documents before releasing withdrawals.') + toolbar('Search user, email, phone, or ID…', `<select id="statusFilter"><option value="">All review states</option><option value="PENDING">Pending</option><option value="VERIFIED">Verified</option><option value="REJECTED">Rejected</option></select>`) + `<section class="panel table-panel">${table(['User', 'Documents', 'Submitted', 'Status', 'Actions'], rows, 'No KYC submissions found.')}${pagination(data)}</section>`; }
    function renderTransactions() { const data = state.cache.transactions; const rows = data.items.map(item => `<tr ${rowClick(item.id, 'transaction')}><td><strong>${escape(item.reference)}</strong><small>${escape(item.id)}</small></td><td>${escape(item.userName)}<small>${escape(item.userId)}</small></td><td>${escape(item.account)}</td><td>${escape(item.type)}</td><td class="amount">${item.type === 'debit' ? '−' : '+'}${money(item.amount)}</td><td>${status(item.status)}</td><td>${shortDate(item.createdAt)}</td></tr>`).join(''); return pageHeading('Transactions', 'Read-only financial ledger view. Historical records cannot be edited.') + toolbar('Search reference, user, reason, or account…', `<select id="statusFilter"><option value="">All statuses</option><option value="completed">Completed</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="refunded">Refunded</option></select>`) + `<section class="panel table-panel">${table(['Reference', 'User', 'Account', 'Type', 'Amount', 'Status', 'Created'], rows, 'No transactions found.')}${pagination(data)}</section>`; }
    function renderAudit() { const data = state.cache.audit; const rows = data.items.map(item => `<tr><td><strong>${escape(item.action)}</strong><small>${escape(item.adminEmail)}</small></td><td>${escape(item.targetType)}<small>${escape(item.targetId)}</small></td><td>${escape(item.reason || '—')}</td><td>${date(item.createdAt)}</td></tr>`).join(''); return pageHeading('Audit logs', 'Administrative actions recorded with actor, target, reason, and state snapshots.') + toolbar('Search action, actor, target, or reason…') + `<section class="panel table-panel">${table(['Action / actor', 'Target', 'Reason', 'Created'], rows, 'No admin actions recorded yet.')}${pagination(data)}</section>`; }
    // ---- Settings: every operational value is editable and saved together ----
    const SETTING_FIELDS = [
        { key: 'minWithdrawal', label: 'Withdrawal limit (minimum balance)', unit: 'GHS', step: '0.01', help: 'Smallest amount a user can withdraw, and the balance they need before withdrawing.' },
        { key: 'minPurchasedCardsForWithdrawal', label: 'Cards required to withdraw', unit: 'cards purchased', step: '1', help: 'How many cards a user must have purchased (free gifts do not count). 0 removes the requirement.' },
        { key: 'dailyPurchaseLimit', label: 'Daily purchase limit', unit: 'cards / day', step: '1', help: 'Maximum cards one user can buy per day, all tiers combined.' },
        { key: 'operationalChargePercent', label: 'Operational charge', unit: '%', step: '0.01', help: 'Deducted from every withdrawal.' },
        { key: 'kycBypassFee', label: 'KYC bypass fee', unit: 'GHS', step: '0.01', help: 'One-time refundable fee that verifies a user for good.' },
        { key: 'rewardMultiplierMin', label: 'Reward multiplier (min)', unit: '×', step: '0.01', help: 'Lowest reward multiplier applied to a card price.' },
        { key: 'rewardMultiplierMax', label: 'Reward multiplier (max)', unit: '×', step: '0.01', help: 'Highest reward multiplier applied to a card price.' },
    ];
    function settingsFormValues(s) {
        return { minWithdrawal: Number(s.minWithdrawal ?? 100), minPurchasedCardsForWithdrawal: Number(s.minPurchasedCardsForWithdrawal ?? 3), dailyPurchaseLimit: Number(s.dailyPurchaseLimit ?? 3), operationalChargePercent: Math.round(Number(s.operationalChargeRate ?? 0.1) * 10000) / 100, kycBypassFee: Number(s.kycBypassFee ?? 70), rewardMultiplierMin: Number(s.rewardMultiplierMin ?? 3.52), rewardMultiplierMax: Number(s.rewardMultiplierMax ?? 4.42) };
    }
    function settingsPanel(s) {
        const values = settingsFormValues(s);
        return `<div class="panel" style="margin-top:16px"><div class="panel-heading"><h3>Platform settings</h3></div>
            <p style="color:var(--muted);line-height:1.7;margin:0 0 14px">Changes apply immediately to everyone.</p>
            <div class="settings-form" id="settingsForm">${SETTING_FIELDS.map(f => `<label class="setting-field"><span>${escape(f.label)}</span><div class="setting-input"><input type="number" inputmode="decimal" step="${f.step}" data-setting="${f.key}" data-original="${values[f.key]}" value="${values[f.key]}"><em>${escape(f.unit)}</em></div><small>${escape(f.help)}</small></label>`).join('')}</div>
            <div style="display:flex;align-items:center;gap:12px;margin-top:14px;flex-wrap:wrap"><button type="button" class="btn-save-req" id="settingsSave" disabled>Save changes</button><button type="button" class="btn-save-req" id="settingsReset" style="background:transparent" disabled>Discard</button><span id="settingsMsg" style="color:var(--muted);font-size:12px">No unsaved changes.</span></div></div>`;
    }
    function settingsFormState() {
        const inputs = [...document.querySelectorAll('#settingsForm [data-setting]')];
        const changed = inputs.filter(i => i.value !== i.dataset.original);
        const invalid = inputs.some(i => i.value.trim() === '' || !Number.isFinite(Number(i.value)));
        return { inputs, changed, invalid };
    }
    function syncSettingsControls() {
        const save = $('#settingsSave'); if (!save) return;
        const { changed, invalid } = settingsFormState();
        save.disabled = invalid || !changed.length;
        $('#settingsReset').disabled = !changed.length;
        $('#settingsMsg').textContent = invalid ? 'Enter a number in every field.' : changed.length ? `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}.` : 'No unsaved changes.';
    }
    async function toggleBalancePurchase(button) {
        const id = button.dataset.toggleBalance; const enable = button.dataset.enabled !== '1';
        button.disabled = true;
        try {
            await api(`/api/admin/users/${encodeURIComponent(id)}/balance-purchase`, { method: 'POST', body: JSON.stringify({ enabled: enable }) });
            toast(enable ? 'This user can now buy cards with their redeemed balance.' : 'Balance buying turned off for this user.');
            await loadView(state.view);
        } catch (error) { toast(error.message); button.disabled = false; }
    }
    async function saveSettings() {
        const save = $('#settingsSave'); const { changed } = settingsFormState(); if (!changed.length) return;
        const payload = {};
        changed.forEach(i => { const v = Number(i.value); if (i.dataset.setting === 'operationalChargePercent') payload.operationalChargeRate = Math.round(v * 100) / 10000; else payload[i.dataset.setting] = v; });
        save.disabled = true;
        try {
            const result = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(payload) });
            state.summary.settings = { ...(state.summary.settings || {}), ...result.settings };
            toast('Settings saved. They now apply to all users.');
            render('settings');
        } catch (error) { toast(error.message); syncSettingsControls(); }
    }
    function renderSettings() { const s = state.summary?.settings || {}; return pageHeading('Settings', 'Operational configuration. Every value below can be edited.') + settingsPanel(s) + `<div class="settings-grid" style="margin-top:16px"><div class="setting"><span>Payment service</span><strong>${s.hubConfigured ? 'Configured' : 'Not configured'}</strong></div></div><div class="panel" style="margin-top:16px"><div class="panel-heading"><h3>Financial safety</h3></div><p style="color:var(--muted);line-height:1.7;margin:0">Direct balance editing, payment status editing, transaction editing, and environment-secret editing are not available in this console. Corrections must be represented by controlled backend workflows and audited compensating records.</p></div>`; }
    function renderReconciliation() { return pageHeading('Payment reconciliation', 'Compare app and Payment Hub references before investigating a top-up.') + `<section class="panel"><div class="panel-heading"><h3>Open a deposit from the Deposits page</h3></div><p style="margin:0;color:var(--muted);line-height:1.7">Deposits store the Payment Hub / Paystack reference alongside the local record, so the console clearly labels any unavailable external data instead of inventing a status.</p><button class="primary-button" style="margin-top:18px" data-go="deposits">View deposits</button></section>`; }

    async function openDetail(type, id) {
        const endpoint = { user: `/api/admin/users/${encodeURIComponent(id)}`, transaction: `/api/admin/transactions?search=${encodeURIComponent(id)}&pageSize=1`, purchase: `/api/admin/purchases?search=${encodeURIComponent(id)}&pageSize=1`, deposit: `/api/admin/reconciliation/${encodeURIComponent(id)}`, withdrawal: `/api/admin/withdrawals?search=${encodeURIComponent(id)}&pageSize=1`, redemption: `/api/admin/redemptions?search=${encodeURIComponent(id)}&pageSize=1`, card: `/api/admin/cards?search=${encodeURIComponent(id)}&pageSize=1`, kyc: `/api/admin/users/${encodeURIComponent(id)}` }[type];
        if (!endpoint) return;
        try {
            const data = await api(endpoint); let html = '';
            if (type === 'user' || type === 'kyc') html = renderUserDrawer(data);
            else if (type === 'deposit') html = renderReconDrawer(data);
            else { const value = data.items?.[0] || data; html = renderObjectDrawer(type, value); }
            $('#drawerContent').innerHTML = html; $('#overlay').classList.add('open'); $('#detailDrawer').classList.add('open'); setIcons();
        } catch (error) { toast(error.message); }
    }
    function renderUserDrawer(data) { const user = data.user; const docs = data.kycSubmission?.documents || []; return `<p class="eyebrow">CUSTOMER ACCOUNT</p><h2 class="drawer-title">${escape(user.name)}</h2><p class="drawer-subtitle">${escape(user.id)} · ${escape(user.email || user.phone)}</p><div class="detail-grid"><div class="detail-cell"><span>Wallet Balance</span><strong>${money(user.walletBalance)}</strong></div><div class="detail-cell"><span>Redeemed Balance</span><strong>${money(user.redeemedBalance)}</strong></div><div class="detail-cell"><span>KYC</span><strong>${status(user.kycStatus)}</strong></div><div class="detail-cell"><span>Account</span><strong>${user.blocked ? status('blocked') : status('active')}</strong></div><div class="detail-cell"><span>Joined</span><strong>${date(user.createdAt)}</strong></div><div class="detail-cell"><span>Purchases</span><strong>${user.purchaseCount}</strong></div><div class="detail-cell"><span>Redemptions</span><strong>${user.redemptionCount}</strong></div></div><div class="drawer-section"><h3>Identity</h3><div class="detail-grid"><div class="detail-cell"><span>Email</span><strong>${escape(user.email || '—')}</strong></div><div class="detail-cell"><span>Phone</span><strong>${escape(user.phone || '—')}</strong></div><div class="detail-cell"><span>Active sessions</span><strong>${user.sessionCount}</strong></div></div></div><div class="drawer-section"><h3>Account access</h3>${user.blocked ? `<p style="color:var(--muted);margin:0 0 12px">Blocked ${date(user.blockedAt)}${user.blockedReason ? ` — “${escape(user.blockedReason)}”` : ''}. They cannot sign in, buy cards, or withdraw while blocked.</p><button class="tiny-button" data-action="unblock-user" data-id="${escape(user.id)}">Unblock user</button>` : `<p style="color:var(--muted);margin:0 0 12px">This account can sign in and transact normally.</p><button class="tiny-button danger" data-action="block-user" data-id="${escape(user.id)}">Block user</button>`}</div><div class="drawer-section"><h3>KYC documents</h3><div class="doc-list">${docs.length ? docs.map(doc => `<a class="doc-link" target="_blank" rel="noreferrer" href="/api/admin/users/${encodeURIComponent(user.id)}/kyc/documents/${encodeURIComponent(doc.storageKey)}"><span>${escape(doc.name)}</span><strong>${escape(doc.type)}</strong></a>`).join('') : '<p style="color:var(--muted)">No stored documents.</p>'}</div></div><div class="drawer-section"><h3>Recent financial activity</h3>${data.transactions.slice(0, 8).map(item => `<div class="recon-line"><span>${escape(item.reason)}</span><strong>${item.type === 'debit' ? '−' : '+'}${money(item.amount)}</strong></div>`).join('') || '<p style="color:var(--muted)">No transactions.</p>'}</div>`; }
    function renderReconDrawer(data) { const s = data.siteA, p = data.paystack; return `<p class="eyebrow">PAYMENT RECONCILIATION</p><h2 class="drawer-title">${money(s.amount)}</h2><p class="drawer-subtitle">${escape(s.transactionId || s.id)} · ${escape(s.userName)}</p><div class="split-grid"><div class="recon-card"><h4>App</h4>${reconLine('Status', status(s.status))}${reconLine('Reference', s.reference)}${reconLine('Amount', money(s.amount))}${reconLine('Expiry', date(s.expiresAt))}</div><div class="recon-card"><h4>Paystack</h4>${reconLine('Status', status(p.status))}${reconLine('Reference', p.reference || '—')}${reconLine('Amount minor', p.amountMinor ? String(p.amountMinor) : '—')}${reconLine('Currency', p.currency)}</div></div>`; }
    function reconLine(label, value) { return `<div class="recon-line"><span>${escape(label)}</span><strong>${typeof value === 'string' && value.startsWith('<span') ? value : escape(value)}</strong></div>`; }
    function renderObjectDrawer(type, value) { if (!value) return '<div class="empty">Record not found.</div>'; const title = value.title || value.reason || value.cardTitle || value.reference || value.orderId || value.id; const entries = Object.entries(value).filter(([key, val]) => val !== undefined && val !== null && typeof val !== 'object' && !['passwordHash', 'pinHash', 'idempotencyKey'].includes(key)).slice(0, 24); return `<p class="eyebrow">${escape(type.toUpperCase())} DETAIL</p><h2 class="drawer-title">${escape(title)}</h2><p class="drawer-subtitle">Read-only operational record</p><div class="detail-grid">${entries.map(([key, val]) => `<div class="detail-cell"><span>${escape(key.replaceAll(/([A-Z])/g, ' $1'))}</span><strong>${escape(String(val))}</strong></div>`).join('')}</div>`; }

    function openAction(action, id) { state.action = { action, id }; const copy = { approve: ['Approve withdrawal', 'This will mark the pending withdrawal as approved. Confirm the requested amount and payout before continuing.'], reject: ['Reject withdrawal', 'This will reject the withdrawal and return the requested amount to Redeemed Balance.'], 'verify-kyc': ['Verify KYC', 'This will verify the user and release their KYC-blocked withdrawals to the pending queue.'], 'reject-kyc': ['Reject KYC', 'This will mark the user KYC as rejected. A reason is required.'], 'block-user': ['Block user', 'This will immediately sign the user out and prevent them from logging in, buying cards, or withdrawing until unblocked. A reason is required.'], 'unblock-user': ['Unblock user', 'This will restore the user\'s ability to sign in, buy cards, and withdraw.'] }[action]; const eyebrow = { approve: 'WITHDRAWAL REVIEW', reject: 'WITHDRAWAL REVIEW', 'verify-kyc': 'KYC REVIEW', 'reject-kyc': 'KYC REVIEW', 'block-user': 'ACCOUNT ACCESS', 'unblock-user': 'ACCOUNT ACCESS' }[action]; $('#actionEyebrow').textContent = eyebrow; $('#actionTitle').textContent = copy[0]; $('#actionCopy').textContent = copy[1]; $('#actionNote').value = ''; $('#actionError').textContent = ''; $('#actionModal').classList.add('open'); }
    async function confirmAction() { const { action, id } = state.action || {}; const note = $('#actionNote').value.trim(); if (!note) return $('#actionError').textContent = 'A reason or note is required.'; const endpoint = { approve: `/api/admin/withdrawals/${encodeURIComponent(id)}/approve`, reject: `/api/admin/withdrawals/${encodeURIComponent(id)}/reject`, 'verify-kyc': `/api/admin/users/${encodeURIComponent(id)}/kyc/verify`, 'reject-kyc': `/api/admin/users/${encodeURIComponent(id)}/kyc/reject`, 'block-user': `/api/admin/users/${encodeURIComponent(id)}/block`, 'unblock-user': `/api/admin/users/${encodeURIComponent(id)}/unblock` }[action]; try { $('#actionConfirm').disabled = true; await api(endpoint, { method: 'POST', body: JSON.stringify({ note }) }); $('#actionModal').classList.remove('open'); toast('Action completed and recorded in the audit log.'); if (action === 'block-user' || action === 'unblock-user') { if (state.view === 'users') await loadView(state.view); await openDetail('user', id); } else { await loadView(state.view); } } catch (error) { $('#actionError').textContent = error.message; } finally { $('#actionConfirm').disabled = false; } }

    document.addEventListener('input', event => { if (event.target.matches?.('#settingsForm [data-setting]')) syncSettingsControls(); });
    document.addEventListener('click', event => {
        const balanceBtn = event.target.closest('[data-toggle-balance]');
        if (balanceBtn) return toggleBalancePurchase(balanceBtn);
        if (event.target.closest('#settingsSave')) return saveSettings();
        if (event.target.closest('#settingsReset')) { document.querySelectorAll('#settingsForm [data-setting]').forEach(i => { i.value = i.dataset.original; }); return syncSettingsControls(); }
        const navButton = event.target.closest('[data-view]'); if (navButton) return nav(navButton.dataset.view);
        const go = event.target.closest('[data-go]'); if (go) return nav(go.dataset.go);
        const action = event.target.closest('[data-action]'); if (action) return openAction(action.dataset.action, action.dataset.id);
        const detail = event.target.closest('[data-detail-type]'); if (detail) return openDetail(detail.dataset.detailType, detail.dataset.detailId);
        const pageButton = event.target.closest('[data-page]'); if (pageButton && !pageButton.disabled) { state.page += pageButton.dataset.page === 'next' ? 1 : -1; return loadView(state.view); }
    });
    $('#adminLoginForm').addEventListener('submit', async event => { event.preventDefault(); $('#loginError').textContent = ''; try { const result = await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#adminEmail').value, password: $('#adminPassword').value }) }); showApp(result.admin); } catch (error) { $('#loginError').textContent = error.message; } });
    $('#logoutButton').addEventListener('click', async () => { await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {}); showLogin('You have been signed out.'); });
    $('#mobileMenu').addEventListener('click', () => { $('#sidebar').classList.toggle('open'); $('#overlay').classList.toggle('open', $('#sidebar').classList.contains('open')); });
    $('#overlay').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#overlay').classList.remove('open'); $('#detailDrawer').classList.remove('open'); });
    $('#drawerClose').addEventListener('click', () => { $('#detailDrawer').classList.remove('open'); $('#overlay').classList.remove('open'); });
    $('#actionClose').addEventListener('click', () => $('#actionModal').classList.remove('open'));
    $('#actionCancel').addEventListener('click', () => $('#actionModal').classList.remove('open'));
    $('#actionConfirm').addEventListener('click', confirmAction);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('#detailDrawer').classList.remove('open'); $('#actionModal').classList.remove('open'); $('#overlay').classList.remove('open'); } });
    document.addEventListener('click', event => { if (event.target.id === 'applyFilters') { state.search = $('#viewSearch')?.value || ''; state.status = $('#statusFilter')?.value || ''; state.page = 1; loadView(state.view); } });
    document.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.id === 'viewSearch') $('#applyFilters')?.click(); });
    api('/api/admin/auth/session').then(result => showApp(result.admin)).catch(() => showLogin());
    initPullToRefresh();
})();
