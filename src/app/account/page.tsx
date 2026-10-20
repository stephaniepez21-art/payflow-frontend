"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, type ApiMandate, type ApiVaultEvent } from "@/lib/api";
import { buildUpcomingChargesCalendar, CALENDAR_FILENAME } from "@/lib/calendar";
import {
  buildPaymentsCsv,
  downloadCsv,
  paymentsFilename,
  type PaymentRow,
} from "@/lib/csv";
import {
  chainMandatesOf,
  sortVaultEventsNewestFirst,
  vaultEventAmount,
  vaultEventLabel,
  vaultEventTone,
} from "@/lib/chain";
import { config } from "@/lib/config";
import {
  discountBadge,
  nextChargeAmount,
  remainingDiscountCharges,
} from "@/lib/discount";
import {
  mandateIsPastDue,
  mandatePastDueUntil,
  mandatePauseUntil,
  payflow,
  server,
  vaultSupportsDepositFor,
  validateRecipient,
} from "@/lib/payflow";
import { mandateStatus } from "@/lib/payflow";
import { createdAtDate, paymentDateRange, paymentRow, sortPaymentsNewestFirst } from "@/lib/payments";
import { useWallet } from "@/lib/wallet";
import {
  formatPeriod,
  formatWhen,
  fromStroops,
  maxDeposit,
  spendableBalance,
  toStroops,
} from "@/lib/format";
import { metaFor, useTokenMetas } from "@/lib/token";
import {
  checkAmount,
  formatAmount,
  formatDate,
  formatPeriod,
  fromStroops,
  minPauseDate,
  parseAmount,
  parsePauseDate,
  resumeDate,
  shortAddress,
} from "@/lib/format";
import { buildChargeSchedule, chargeShortfall } from "@/lib/schedule";
import { describeTrialEnd } from "@/lib/trial";
import { loadTokenMeta, metaFor, useTokenMetas } from "@/lib/token";
import { AmountInput } from "@/components/AmountInput";
import {
  Badge,
  Empty,
  MerchantAccount,
  Notice,
  Panel,
  SkeletonRows,
  Stat,
  TimeAgo,
  TxLink,
} from "@/components/ui";

export default function AccountPage() {
  const { account: walletAccount, address, networkMismatch, refreshAccount, signXdr } =
    useWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [mandates, setMandates] = useState<ApiMandate[] | null>(null);
  const [history, setHistory] = useState<ApiVaultEvent[] | null>(null);
  const [indexerAvailable, setIndexerAvailable] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Cancelling is permanent, so the first click only reveals Keep/Confirm.
  // One id, not a set: only one mandate can be awaiting confirmation at a
  // time, which keeps the destructive action unambiguous.
  const [confirmCancel, setConfirmCancel] = useState<number | null>(null);
  // The mandate whose date picker is open, and the date typed into it. Like
  // `confirmCancel`, one at a time keeps the pending write unambiguous.
  const [pauseFor, setPauseFor] = useState<number | null>(null);
  const [pauseDate, setPauseDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Whether the mandate list came from the indexer. Payment history lives only
  // there, so this is what gates the CSV export.
  const [mandatesFromApi, setMandatesFromApi] = useState(false);
  // Whether the deployed vault contract supports depositing into another
  // account's vault (payflow-contract#29). null while the probe is in flight.
  const [fundSupport, setFundSupport] = useState<boolean | null>(null);
  const [fundRecipient, setFundRecipient] = useState("");
  const [fundAmount, setFundAmount] = useState("");
  // The recipient awaiting a second-click confirmation — one at a time.
  const [fundFor, setFundFor] = useState<string | null>(null);

  // Read inside async callbacks to detect a wallet account switch mid-load:
  // the closure's `address` is the account the request started for, which may
  // no longer be the account whose page is on screen.
  const addressRef = useRef<string | null>(address);

  // The vault holds the configured token; each mandate carries the token it
  // was opened against, which the indexer does not report.
  const metas = useTokenMetas([
    config.contracts.token,
    ...(mandates ?? []).map((m) => m.token ?? config.contracts.token),
  ]);
  const vaultMeta = metaFor(metas, config.contracts.token);

  /** Whether the recipient address and amount are right to submit right now. */
  const recipientDisplayError = fundRecipient.trim()
    ? validateRecipient(fundRecipient)
    : null;
  const fundAmountCheck = checkAmount(fundAmount, vaultMeta.decimals);
  const fundStroops = fundAmountCheck.ok ? fundAmountCheck.stroops : 0n;

  // The vault holds the configured token; each mandate carries the token it
  // was opened against, which the indexer does not report.
  const metas = useTokenMetas([
    config.contracts.token,
    ...(mandates ?? []).map((m) => m.token ?? config.contracts.token),
  ]);
  const vaultMeta = metaFor(metas, config.contracts.token);

  /**
   * What a "Max" fill would put in the box, in stroops.
   *
   * This is the wallet's *native* balance: the fee has to come from it, and so
   * does the amount being deposited. That is only the same thing as the vault's
   * token if the vault holds the native asset, which is what the deployed suite
   * does — its token contract reports `symbol() == "native"` and 7 decimals.
   * A vault holding a separate SEP-41 token would need the token's own
   * balance here instead.
   */
  const nativeMax =
    walletAccount.state === "loaded"
      ? maxDeposit(walletAccount.account.balance, walletAccount.account.subentryCount)
      : 0n;
  const nativeSpendable =
    walletAccount.state === "loaded"
      ? spendableBalance(walletAccount.account.balance, walletAccount.account.subentryCount)
      : null;

  /**
   * The wallet's own native balance, next to the field it funds. It says
   * nothing rather than "0" while loading, because a wrong zero reads as
   * "you are broke".
   */
  const walletLabel = (() => {
    switch (walletAccount.state) {
      case "loaded":
        return `Wallet: ${fromStroops(nativeSpendable ?? 0n)} XLM`;
      case "missing":
        return "Wallet: not funded";
      case "error":
        return "Wallet: balance unavailable";
      default:
        return "Wallet: reading…";
    }
  })();

  const load = useCallback(async () => {
    addressRef.current = address;
    if (!address) return;
    const who = address;
    const [bal, res, hist] = await Promise.allSettled([
      payflow.vaultBalance(who, who, config.contracts.token),
      api.mandatesOf(who),
      api.vaultHistory(who),
    ]);
    // The wallet may have switched accounts while those reads were in flight.
    // Applying them would show one account's balance under another's address.
    if (addressRef.current !== who) return;
    if (bal.status === "fulfilled") setBalance(bal.value);

    if (res.status === "fulfilled" && res.value) {
      setMandates(res.value.mandates);
      setMandatesFromApi(true);
    } else {
      // No indexer: read the subscriber's mandates from the contract.
      try {
        const fromChain = await chainMandatesOf(who, who);
        if (addressRef.current !== who) return;
        setMandates(fromChain);
      } catch {
        if (addressRef.current !== who) return;
        setMandates([]);
      }
      setMandatesFromApi(false);
    }

    // A contract fallback above may have awaited long enough for an account
    // switch; do not attach the old account's history to the new one.
    if (addressRef.current !== who) return;

    // Vault history lives only in the indexer; without a backend there is no
    // contract-side event log to fall back to, so we report what is knowable.
    if (hist.status === "fulfilled" && hist.value) {
      setHistory(sortVaultEventsNewestFirst(hist.value.events));
      setIndexerAvailable(true);
    } else {
      setHistory([]);
      setIndexerAvailable(false);
    }
  }, [address]);

  useEffect(() => {
    // A different account means every previous value belongs to someone else:
    // clear them before the new reads start so no stale row or export survives
    // a wallet switch. Clearing here (rather than in `load`) keeps the refresh
    // after a transaction from flashing the page back to skeletons.
    setBalance(null);
    setMandates(null);
    setHistory(null);
    setIndexerAvailable(false);
    setMandatesFromApi(false);
    setInfo(null);
    setError(null);
    setDone(null);
    setExporting(false);
    void load();
  }, [load]);

  // A wallet switch mid-flow must not leave another account's mandate in the
  // confirming state.
  useEffect(() => {
    setConfirmCancel(null);
    setPauseFor(null);
    setFundFor(null);
  }, [address]);

  // Probe whether the deployed vault contract carries deposit_for. The sponsor
  // control stays hidden until the contract answers: a contract that predates
  // payflow-contract#29 cannot service the write, so offering it would only
  // fail at signing time.
  useEffect(() => {
    if (!address) {
      setFundSupport(null);
      return;
    }
    let live = true;
    void vaultSupportsDepositFor(address).then((supported) => {
      if (live) setFundSupport(supported);
    });
    return () => {
      live = false;
    };
  }, [address]);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setDone(null);
    setInfo(null);
    try {
      setDone(await fn());
      await load();
      // Every write here spends the native balance on fees, so the header's
      // figure is stale the moment the transaction lands.
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Reveal Keep/Confirm for the sponsor deposit. One recipient at a time. */
  async function fundAnother() {
    if (recipientDisplayError || !fundAmountCheck.ok) return;
    setFundFor(fundRecipient.trim());
  }

  async function fundConfirmed() {
    if (!address || !signXdr || !fundFor || !fundAmountCheck.ok) return;
    await run(`fund-for-${fundFor}`, () =>
      payflow.depositFor(address, signXdr, fundFor, config.contracts.token, fundStroops),
    );
    setFundFor(null);
    setFundRecipient("");
    setFundAmount("");
  }

  async function handleCancelAll() {
    if (!address) return;

    const allMandates = await chainMandatesOf(address, address);
    const toCancel = allMandates.filter((m) =>
      mandateStatus(m.status) === "Active" || mandateStatus(m.status) === "Paused",
    );

    if (toCancel.length === 0) {
      setError("No active or paused mandates to cancel.");
      return;
    }

    if (!window.confirm(`This will cancel ${toCancel.length} mandate${toCancel.length !== 1 ? "s" : ""}. Continue?`)) {
      return;
    }

    setBusy("cancel-all");
    setError(null);
    setDone(null);

    const PAGE_SIZE = 50;
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < toCancel.length; i += PAGE_SIZE) {
      const page = toCancel.slice(i, i + PAGE_SIZE);
      const promises = page.map((m) =>
        payflow.cancel(address, signXdr, m.id).then(() => {
          completed += 1;
        }).catch((err) => {
          failed += 1;
          setError(
            err instanceof Error ? err.message : String(err),
          );
        }),
      );
      await Promise.all(promises);
    }

    const result = completed
      ? `Cancelled ${completed} mandate${completed !== 1 ? "s" : ""}${
          failed > 0 ? ` (${failed} failed)` : ""
        }`
      : "No mandates were cancelled";

    setDone(result);
    await load();
    setBusy(null);
  }

  const activeCount = mandates?.filter((m) => m.status === "Active").length ?? 0;

  /**
   * Whether the contract behind these mandates can service a dated pause.
   *
   * A contract built before payflow-contract#41 decodes its mandates without
   * `pause_until`, so the absence of that field is the signal; there is no
   * method to probe. Checking the mandates already on screen costs no extra
   * round trip. With an indexer configured, it has to serve the field too —
   * when it cannot, hiding the control is still the honest choice, because
   * offering it would send a transaction the deployed contract may reject.
   */
  const pauseSupported = (mandates ?? []).some(
    (m) => mandatePauseUntil(m) !== null,
  );

  function openPausePicker(mandateId: number) {
    setPauseFor(mandateId);
    // Default to a week out: long enough to be the common case, short enough
    // that the user can still see what they picked.
    const week = new Date(Date.now() + 7 * 86_400_000);
    setPauseDate(week.toISOString().slice(0, 10));
    setConfirmCancel(null);
    setError(null);
  }

  async function pauseUntil(mandateId: number) {
    if (!address) return;
    const until = parsePauseDate(pauseDate);
    if (until === null) {
      setError("Pick a date for the mandate to resume on.");
      return;
    }
    if (until * 1000 <= Date.now()) {
      setError("Pick a date in the future.");
      return;
    }
    await run(`pause-until-${mandateId}`, () =>
      payflow.pauseUntil(address, signXdr, mandateId, until),
    );
    setPauseFor(null);
  }

  /**
   * The .ics is generated in the browser from the same mandates shown on this
   * page, so the calendar also works when the indexer is unreachable and the
   * list came from contract state.
   */
  function downloadCalendar() {
    if (!mandates) return;
    try {
      const calendar = buildUpcomingChargesCalendar(mandates);
      const blob = new Blob([calendar], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = CALENDAR_FILENAME;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoke after the browser has started the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the calendar file.");
    }
  }

  /**
   * The date of a charge's transaction.
   *
   * Indexer charges carry a ledger, not a timestamp. The close time is read
   * from the transaction itself and any failure leaves "—": a payment record
   * must not invent today's date for a charge that settled months ago.
   */
  async function chargeDate(txHash: string): Promise<string> {
    try {
      const tx = await server.getTransaction(txHash);
      if ("createdAt" in tx) return createdAtDate(tx.createdAt as number);
    } catch {
      // RPC unavailable or the transaction is older than the node's history.
    }
    return "—";
  }

  /**
   * Export every charge settled against the subscriber's mandates as CSV.
   *
   * Per-charge amounts, fees and hashes exist only in the indexer; contract
   * state keeps just `charges_made`. The button is therefore disabled in
   * contract-only mode instead of shipping an empty file. If any mandate's
   * history cannot be read the whole export aborts: a file that silently omits
   * a subscription would look complete while understating what was paid.
   *
   * Read-only — it signs nothing — so a wallet on the wrong network can still
   * export. The account-change guards only stop one account's rows from being
   * written under another account's address.
   */
  async function exportPayments() {
    if (!address || !mandates || !mandatesFromApi) return;
    const who = address;
    setExporting(true);
    setError(null);
    setInfo(null);
    try {
      const histories = await Promise.all(
        mandates.map(async (mandate) => ({ mandate, result: await api.charges(mandate.id) })),
      );
      if (addressRef.current !== who) return;

      const unreadable = histories.filter(({ result }) => result === null);
      if (unreadable.length > 0) {
        throw new Error(
          `Could not read payment history for mandate${unreadable.length === 1 ? "" : "s"} ${unreadable
            .map(({ mandate }) => `#${mandate.id}`)
            .join(", ")}. Nothing was exported, so the file cannot omit payments.`,
        );
      }

      const dateCache = new Map<string, string>();
      const rows: PaymentRow[] = [];
      for (const { mandate, result } of histories) {
        if (!result) continue;
        const tokenContract = mandate.token ?? config.contracts.token;
        // Read the token's metadata here rather than trusting the map rendered
        // above: decimals must be right even if the page has not finished
        // loading them, and a mandate in another token must use its own scale.
        const meta = await loadTokenMeta(tokenContract);
        for (const charge of result.charges) {
          let date = dateCache.get(charge.tx_hash);
          if (date === undefined) {
            date = await chargeDate(charge.tx_hash);
            dateCache.set(charge.tx_hash, date);
          }
          rows.push(paymentRow(charge, mandate, meta, tokenContract, date));
        }
      }
      if (addressRef.current !== who) return;

      if (rows.length === 0) {
        setInfo("No payments to export yet. Charges appear here once they settle on-chain.");
        return;
      }

      const sorted = sortPaymentsNewestFirst(rows);
      const { from, to } = paymentDateRange(sorted);
      downloadCsv(buildPaymentsCsv(sorted), paymentsFilename(who, from, to));
      setInfo(`Exported ${sorted.length} payment${sorted.length === 1 ? "" : "s"} to CSV.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the CSV file.");
    } finally {
      setExporting(false);
    }
  }

  if (!address) {
    return (
      <Panel title="My account">
        <Empty
          title="No wallet connected"
          action={
            <button
              type="button"
              className="btn-primary"
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          }
        >
          Connect a wallet to see your vault balance, fund it, and manage your
          subscriptions. Nothing is sent to the network until you approve a
          transaction in your wallet.
        </Empty>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Vault balance"
          loading={balance === null}
          value={`${fromStroops(balance ?? 0n, 4, vaultMeta.decimals)} ${vaultMeta.symbol}`}
          hint="Available to be charged"
        />
        <Stat
          label="Active subscriptions"
          loading={mandates === null}
          value={activeCount}
        />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {info && (
        <Notice tone="info">
          {/* Announced when the export finishes, so a screen-reader user knows
              the file was produced without having to hunt for the button. */}
          <span role="status">{info}</span>
        </Notice>
      )}
      {done && (
        <Notice tone="ok">
          Done. Transaction <TxLink hash={done} />
        </Notice>
      )}

      <Panel
        title="Fund your vault"
        subtitle="Charges are debited from this balance. Withdraw at any time — nothing is locked."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <label className="label" htmlFor="amount">
              Amount ({vaultMeta.symbol})
            </label>
            <div className="flex gap-2">
              <input
                id="amount"
                className="input"
                inputMode="decimal"
                placeholder="5.0"
                value={amount}
                aria-describedby="wallet-balance"
                onChange={(e) => setAmount(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost whitespace-nowrap"
                disabled={busy !== null || networkMismatch || nativeMax <= 0n}
                title={
                  nativeMax > 0n
                    ? `Fill ${fromStroops(nativeMax)} XLM: your balance less the minimum account balance and a 1 XLM reserve for the transaction fee`
                    : "Nothing to deposit — your balance does not cover the reserve"
                }
                onClick={() => setAmount(fromStroops(nativeMax))}
              >
                Max
              </button>
            </div>
            {/* Under the field rather than beside the label: at 375px the two
                share one row and both wrap. */}
            <p id="wallet-balance" className="mt-1 text-xs text-muted">
              {walletLabel}
            </p>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={busy !== null || networkMismatch}
            onClick={() =>
              void run("deposit", () =>
                payflow.deposit(
                  address,
                  signXdr,
                  config.contracts.token,
                  toStroops(amount, vaultMeta.decimals),
                ),
              )
            }
          >
            {busy === "deposit" ? "Depositing…" : "Deposit"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null || networkMismatch}
            onClick={() =>
              void run("withdraw", () =>
                payflow.withdraw(
                  address,
                  signXdr,
                  config.contracts.token,
                  toStroops(amount, vaultMeta.decimals),
                ),
              )
            }
          >
            {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
          </button>
        </div>
      </Panel>

      {fundSupport === true && (
        <Panel
          title="Fund another account"
          subtitle="Send tokens to someone else's vault. Only the recipient can withdraw — you cannot cancel or refund the deposit."
        >
          {fundFor ? (
            <div className="space-y-3">
              <p className="text-sm">
                <span className="font-mono truncate">{shortAddress(address)}</span>{" "}
                pays{" "}
                <span className="font-medium">{formatAmount(fundStroops, vaultMeta)}</span>{" "}
                into <span className="font-mono truncate">{shortAddress(fundFor)}</span>{"'s vault"}
              </p>
              <p className="mt-1 text-xs text-muted">
                Only{" "}
                <span className="font-mono truncate">{shortAddress(fundFor)}</span> can withdraw
                it — you cannot cancel or refund this deposit.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== null || networkMismatch}
                  onClick={fundConfirmed}
                >
                  {busy === `fund-for-${fundFor}` ? "Funding…" : "Fund"}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy !== null}
                  onClick={() => setFundFor(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[14rem] flex-1">
                <label className="label" htmlFor="fund-recipient">
                  Recipient address
                </label>
                <input
                  id="fund-recipient"
                  className="input"
                  placeholder="GABC…"
                  value={fundRecipient}
                  onChange={(e) => setFundRecipient(e.target.value)}
                  aria-invalid={Boolean(recipientDisplayError)}
                  aria-describedby={recipientDisplayError ? "fund-recipient-error" : undefined}
                  disabled={busy !== null}
                />
                {recipientDisplayError && (
                  <p id="fund-recipient-error" className="mt-1 text-sm text-danger">
                    {recipientDisplayError}
                  </p>
                )}
              </div>
              <div className="min-w-[12rem] flex-1">
                <AmountInput
                  id="fund-amount"
                  label={`Amount (${vaultMeta.symbol})`}
                  value={fundAmount}
                  onChange={setFundAmount}
                  decimals={vaultMeta.decimals}
                  placeholder="5.0"
                  disabled={busy !== null}
                />
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={
                  busy !== null ||
                  networkMismatch ||
                  Boolean(recipientDisplayError) ||
                  !fundAmountCheck.ok
                }
                onClick={fundAnother}
              >
                {busy === "fund-another" ? "Funding…" : "Fund"}
              </button>
            </div>
          )}
        </Panel>
      )}

      <Panel
        title="Vault history"
        subtitle="Deposits, withdrawals and debits behind your balance."
      >
        {history === null ? (
          <Empty>Loading history…</Empty>
        ) : history.length === 0 ? (
          indexerAvailable ? (
            <Empty
              title="No vault activity yet"
              action={
                <a href="#amount" className="btn-primary">
                  Make a deposit
                </a>
              }
            >
              Deposits, withdrawals and debit charges appear here as they
              settle. Fund the vault above so charges have a balance to draw
              from.
            </Empty>
          ) : (
            // No indexer, no event log: the notice below says why there is
            // nothing to show. An empty list here would claim “no events”
            // when the truth is “no event source”.
            null
          )
        ) : (
          <div className="space-y-2">
            {history.map((event) => {
              const label = vaultEventLabel(event);
              const eventAmount = vaultEventAmount(event);
              const isCredit = vaultEventTone(event) === "ok";
              return (
                <div
                  key={event.tx_hash}
                  className="flex items-center justify-between gap-3 rounded-lg border border-edge p-3"
                  aria-label={`${label} ${eventAmount} ${vaultMeta.symbol}, ledger ${event.ledger}`}
                >
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-medium">{label}</span>
                    <span className="mono text-xs text-muted">tx</span>
                    <TxLink hash={event.tx_hash} />
                  </div>
                  <div className="text-right">
                    <span
                      className={`font-semibold tabular-nums ${
                        isCredit ? "text-accent" : "text-danger"
                      }`}
                    >
                      {eventAmount} {vaultMeta.symbol}
                    </span>
                    <div className="text-xs text-muted">ledger {event.ledger}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {history !== null && !indexerAvailable && (
          <Notice tone="info">
            Vault history is not available in contract-only mode. It requires
            the payflow-backend indexer (set NEXT_PUBLIC_API_URL). Deposits,
            withdrawals and debits still update your on-chain balance; only
            the event list is missing.
          </Notice>
        )}
      </Panel>

      <Panel
        title="My subscriptions"
        subtitle="Add the next charge to your calendar, or export past payments for your records."
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost whitespace-nowrap"
              disabled={activeCount === 0}
              onClick={downloadCalendar}
              title={
                activeCount === 0
                  ? "No active subscriptions to add"
                  : "Download an .ics file for Google or Apple Calendar"
              }
            >
              Add to calendar
            </button>
            {/*
              Read-only, so it stays enabled on a mismatched network: exporting
              records does not need the wallet's network to match the app's.
              Disabled only when there is nothing it can honestly export.
            */}
            <button
              type="button"
              className="btn-ghost whitespace-nowrap"
              disabled={exporting || !mandatesFromApi || (mandates?.length ?? 0) === 0}
              onClick={() => void exportPayments()}
              aria-label="Export my payments as CSV"
              title={
                !mandatesFromApi
                  ? "Payment history needs the payflow indexer (set NEXT_PUBLIC_API_URL)"
                  : (mandates?.length ?? 0) === 0
                    ? "No subscriptions to export"
                    : "Download a CSV of every charge against your subscriptions"
              }
            >
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
          </div>
        }
      >
        {!mandatesFromApi && mandates !== null && (
          <Notice tone="info">
            Payment history — and this CSV export — come from the payflow indexer,
            which is not reachable here, so the export is unavailable in
            contract-only mode. The chain records how many charges each mandate
            has taken, but not their amounts or transaction hashes. Set
            NEXT_PUBLIC_API_URL and rebuild to enable it; everything else on this
            page still works without a backend.
          </Notice>
        )}
        {mandates === null ? (
          <SkeletonRows rows={2} label="Loading subscriptions" />
        ) : mandates.length === 0 ? (
          <Empty
            title="No subscriptions yet"
            action={
              <Link href="/subscribe" className="btn-primary">
                Browse plans
              </Link>
            }
          >
            Subscribing to a plan opens a mandate, and every mandate shows up
            here with its next charge date. You can pause or cancel any of them
            from this page.
          </Empty>
        ) : (
          <div className="space-y-3">
            {mandates.map((m) => {
              const terminal = m.status === "Cancelled" || m.status === "Completed";
              const meta = metaFor(metas, m.token ?? config.contracts.token);
              return (
                <div key={m.id} className="rounded-lg border border-edge p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Mandate #{m.id}</span>
                        <Badge status={m.status} />
                        {m.ended_by === "merchant" && (
                          <span className="text-xs text-muted">ended by the merchant</span>
                        )}
                      </div>
                      <div className="mt-1 text-sm text-muted">
                        {fromStroops(m.amount, 4, meta.decimals)} {meta.symbol}{" "}
                        {formatPeriod(m.period)} · to <AddressLink value={m.merchant} />
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {m.charges_made} charge{m.charges_made === 1 ? "" : "s"} taken
                        {m.max_charges > 0 && ` of ${m.max_charges}`}
                        {" · next "}
                        {m.status === "Active" ? formatWhen(m.next_charge) : "—"}
                      </div>
                    </div>

                    {!terminal && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy !== null || networkMismatch}
                          onClick={() =>
                            void run(`pause-${m.id}`, () =>
                              payflow.setPaused(
                                address,
                                signXdr,
                                m.id,
                                m.status === "Active",
                              ),
                            )
                          }
                        >
                          {m.status === "Active" ? "Pause" : "Resume"}
                        </button>
                        {/* Offered only against a contract that carries
                            pause_until; see `pauseSupported`. */}
                        {pauseSupported &&
                          (pauseFor === m.id ? (
                            <>
                              <label className="sr-only" htmlFor={`pause-until-${m.id}`}>
                                Resume date for mandate {m.id}
                              </label>
                              <input
                                id={`pause-until-${m.id}`}
                                type="date"
                                className="input"
                                min={minPauseDate()}
                                value={pauseDate}
                                disabled={busy !== null}
                                onChange={(e) => setPauseDate(e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn-primary"
                                disabled={busy !== null || networkMismatch}
                                onClick={() => void pauseUntil(m.id)}
                              >
                                {busy === `pause-until-${m.id}` ? "Pausing…" : "Pause until…"}
                              </button>
                              <button
                                type="button"
                                className="btn-ghost"
                                disabled={busy !== null}
                                onClick={() => setPauseFor(null)}
                              >
                                Back
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={busy !== null || networkMismatch}
                              onClick={() => openPausePicker(m.id)}
                            >
                              Pause until…
                            </button>
                          ))}
                        {confirmCancel === m.id ? (
                          <>
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={busy !== null}
                              autoFocus
                              onClick={() => setConfirmCancel(null)}
                            >
                              Keep
                            </button>
                            <button
                              type="button"
                              className="btn-danger"
                              disabled={busy !== null || networkMismatch}
                              aria-label={`Confirm cancelling subscription #${m.id}`}
                              onClick={() =>
                                void run(`cancel-${m.id}`, () =>
                                  payflow.cancel(address, signXdr, m.id),
                                ).then(() => setConfirmCancel(null))
                              }
                            >
                              {busy === `cancel-${m.id}` ? "Cancelling…" : "Confirm"}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn-ghost text-danger"
                            disabled={busy !== null || networkMismatch}
                            aria-label={`Cancel subscription #${m.id}`}
                            onClick={() => setConfirmCancel(m.id)}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {schedule.charges.length > 0 && (
                    <section
                      className="mt-4 border-t border-edge pt-3"
                      aria-labelledby={`schedule-${m.id}`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <h3 id={`schedule-${m.id}`} className="text-sm font-medium">
                          Upcoming charges
                        </h3>
                        <span className="text-xs text-muted">
                          Next {schedule.charges.length} total{" "}
                          {formatAmount(schedule.total, meta)}
                        </span>
                      </div>
                      <ol className="mt-2 space-y-1.5">
                        {schedule.charges.map((charge) => (
                          <li
                            key={charge.due}
                            className="flex items-baseline justify-between gap-3 text-sm"
                          >
                            <time
                              dateTime={new Date(charge.due * 1000).toISOString()}
                              className="text-muted"
                            >
                              {formatDate(charge.due)}
                            </time>
                            <span className="tabular-nums">
                              {formatAmount(charge.amount, meta)}
                            </span>
                          </li>
                        ))}
                      </ol>
                      <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
                        <span>
                          Running total{" "}
                          <strong className="font-medium text-fg">
                            {formatAmount(schedule.total, meta)}
                          </strong>
                        </span>
                        {schedule.finalDate !== null && (
                          <span>Final charge {formatDate(schedule.finalDate)}</span>
                        )}
                      </div>
                      {shortfall !== null && (
                        <p
                          role="status"
                          className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
                        >
                          Your vault is short by{" "}
                          {formatAmount(shortfall, meta)} for the next charge.
                          Deposit before {formatDate(m.next_charge)} or it will
                          fail.
                        </p>
                      )}
                    </section>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
