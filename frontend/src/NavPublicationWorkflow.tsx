import { useState } from "react";
import { callContract } from "./near-wallet";

type PositionInput = {
  assetId: string;
  symbol: string;
  assetType: string;
  quantity: string;
  unitPrice: string;
  accruedIncome: string;
  priceSource: string;
  priceObservedAt: string;
  maxPriceAgeSeconds: string;
  custodyQuantity: string;
  custodySource: string;
  custodyAsOf: string;
};

type LiabilityInput = {
  description: string;
  amount: string;
  source: string;
  asOf: string;
};

type PreparedSnapshot = {
  dataMode: "OPERATOR_ENTERED";
  provenanceWarning: string;
  context: {
    contractId: string;
    fundId: string;
    publisherId: string;
    approverId: string;
    publicationPaused: boolean;
    totalSupply: string;
    latestSequence: number;
    nextSequence: number;
  };
  checks: Array<{
    name: string;
    status: "MATCHED" | "FAILED";
    expected: string;
    actual: string;
    message: string;
  }>;
  status: "MATCHED" | "FAILED";
  snapshotHash: string;
  merkleRoot: string;
  payload: {
    nav: string;
    navPerShare: string;
    eligibleShares: string;
    grossAssets: string;
    totalLiabilities: string;
    calculationVersion: string;
  };
  onChainArgs: Record<string, unknown> & { sequence: number };
};

type Props = {
  contractId: string;
  fundId: string;
  totalSupply: string;
  latestSequence: number;
  approverId: string;
  publisherId: string;
  walletAccount: string | null;
  publicationPaused: boolean;
  onPublished: () => Promise<void>;
};

const API = import.meta.env.VITE_PROOFNAV_API_URL || "http://127.0.0.1:3001";
const datetimeLocalNow = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const emptyPosition = (): PositionInput => ({
  assetId: "",
  symbol: "",
  assetType: "",
  quantity: "",
  unitPrice: "",
  accruedIncome: "0",
  priceSource: "",
  priceObservedAt: datetimeLocalNow(),
  maxPriceAgeSeconds: "86400",
  custodyQuantity: "",
  custodySource: "",
  custodyAsOf: datetimeLocalNow(),
});
const shortHash = (value: string) => `${value.slice(0, 12)}…${value.slice(-12)}`;
const decimalInput = (value: string, onChange: (value: string) => void, label: string) => (
  <label>{label}<input inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} /></label>
);

export default function NavPublicationWorkflow(props: Props) {
  const [valuationTimestamp, setValuationTimestamp] = useState(datetimeLocalNow);
  const [calculationVersion, setCalculationVersion] = useState("proofnav-nav-v0.1");
  const [positions, setPositions] = useState<PositionInput[]>([emptyPosition()]);
  const [liabilities, setLiabilities] = useState<LiabilityInput[]>([]);
  const [prepared, setPrepared] = useState<PreparedSnapshot | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const invalidate = () => {
    setPrepared(null);
    setApproved(false);
    setMessage("");
  };
  const updatePosition = (index: number, field: keyof PositionInput, value: string) => {
    invalidate();
    setPositions(current => current.map((position, i) => i === index ? { ...position, [field]: value } : position));
  };
  const updateLiability = (index: number, field: keyof LiabilityInput, value: string) => {
    invalidate();
    setLiabilities(current => current.map((liability, i) => i === index ? { ...liability, [field]: value } : liability));
  };
  const toIso = (value: string) => value ? new Date(value).toISOString() : "";

  async function prepareSnapshot() {
    setBusy(true);
    setMessage("");
    setPrepared(null);
    setApproved(false);
    try {
      if (!Number.isSafeInteger(Date.parse(valuationTimestamp))) throw new Error("Enter a valid valuation cut time.");
      const response = await fetch(`${API}/api/v1/nav-snapshots/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          contractId: props.contractId,
          valuationTimestamp: toIso(valuationTimestamp),
          calculationVersion,
          positions: positions.map(position => ({
            ...position,
            priceObservedAt: toIso(position.priceObservedAt),
            custodyAsOf: toIso(position.custodyAsOf),
            maxPriceAgeSeconds: Number(position.maxPriceAgeSeconds),
          })),
          liabilities: liabilities.map(liability => ({ ...liability, asOf: toIso(liability.asOf) })),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        const detail = result.details?.fieldErrors
          ? Object.values(result.details.fieldErrors).flat().join(" ")
          : "";
        throw new Error([result.error, detail].filter(Boolean).join(": "));
      }
      const snapshot = result as PreparedSnapshot;
      if (snapshot.context.contractId !== props.contractId) throw new Error("Backend and dashboard contract accounts do not match.");
      if (snapshot.context.approverId !== props.approverId || snapshot.context.publisherId !== props.publisherId) {
        throw new Error("Contract roles changed. Refresh contract data and prepare the snapshot again.");
      }
      if (snapshot.context.totalSupply !== props.totalSupply || snapshot.context.latestSequence !== props.latestSequence) {
        throw new Error("The on-chain supply or NAV sequence changed. Refresh contract data and prepare the snapshot again.");
      }
      setPrepared(snapshot);
      if (snapshot.status !== "MATCHED") {
        setMessage("Reconciliation failed. Correct the mismatches before requesting approval.");
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshContext() {
    const response = await fetch(`${API}/api/v1/nav-snapshots/context`, { cache: "no-store" });
    const context = await response.json();
    if (!response.ok) throw new Error(context.error || "Could not refresh the on-chain NAV context.");
    if (context.contractId !== props.contractId || context.approverId !== prepared?.context.approverId ||
        context.publisherId !== prepared?.context.publisherId || context.totalSupply !== prepared?.context.totalSupply ||
        context.latestSequence !== prepared?.context.latestSequence || context.publicationPaused) {
      setPrepared(null);
      setApproved(false);
      throw new Error("Contract supply, NAV sequence, or publication status changed. Refresh dashboard data and prepare a new snapshot.");
    }
  }

  async function approveSnapshot() {
    if (!prepared || prepared.status !== "MATCHED" || !props.walletAccount ||
        props.walletAccount !== prepared.context.approverId) return;
    setBusy(true);
    setMessage("");
    try {
      await refreshContext();
      await callContract("approve_snapshot", {
        sequence: prepared.context.nextSequence,
        snapshot_hash: prepared.snapshotHash,
      });
      setApproved(true);
      setMessage(`Snapshot #${prepared.context.nextSequence} approved on NEAR. The publisher can now publish this exact snapshot.`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publishSnapshot() {
    if (!prepared || !approved || prepared.status !== "MATCHED" || !props.walletAccount ||
        props.walletAccount !== prepared.context.publisherId) return;
    setBusy(true);
    setMessage("");
    try {
      await refreshContext();
      const result = await callContract("publish_nav", prepared.onChainArgs) as {
        transaction?: { hash?: string };
        transaction_outcome?: { id?: string };
      };
      const hash = result.transaction?.hash || result.transaction_outcome?.id;
      setMessage(hash ? `NAV #${prepared.context.nextSequence} published. Transaction: ${hash}` : `NAV #${prepared.context.nextSequence} published.`);
      await props.onPublished();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canApprove = Boolean(prepared && prepared.status === "MATCHED" &&
    props.walletAccount === prepared.context.approverId && !props.publicationPaused && !busy);
  const canPublish = Boolean(prepared && approved && prepared.status === "MATCHED" &&
    props.walletAccount === prepared.context.publisherId && !props.publicationPaused && !busy);

  return <section className="panel governance-panel">
    <div className="panel-heading"><div><span className="eyebrow">VALUATION PREPARATION</span><h3>Reconcile and commit NAV snapshot</h3></div></div>
    <p>Contract <b>{props.contractId}</b> · Next sequence <b>#{props.latestSequence + 1}</b> · Live share supply <b>{props.totalSupply}</b> raw units</p>
    <div className="notice">Manual input is operator-attested only. The API checks entered custody quantities against entered accounting quantities and reads live share supply; it does not independently verify custodians, prices, liabilities, or source documents.</div>
    <div className="contract-details nav-input-grid">
      <label>Valuation cut time<input type="datetime-local" value={valuationTimestamp} onChange={event => { invalidate(); setValuationTimestamp(event.target.value); }} /></label>
      <label>Calculation version<input value={calculationVersion} onChange={event => { invalidate(); setCalculationVersion(event.target.value); }} /></label>
    </div>

    <div className="nav-input-section">
      <div className="panel-heading"><div><span className="eyebrow">PORTFOLIO</span><h3>Assets, approved prices and custody</h3></div><button className="secondary-button" type="button" onClick={() => { invalidate(); setPositions(current => [...current, emptyPosition()]); }}>Add asset</button></div>
      {positions.map((position, index) => <fieldset className="nav-input-card" key={`position-${index}`}>
        <legend>Asset {index + 1}</legend>
        <div className="nav-input-grid">
          <label>Asset ID<input value={position.assetId} onChange={event => updatePosition(index, "assetId", event.target.value)} placeholder="asset-id" /></label>
          <label>Symbol<input value={position.symbol} onChange={event => updatePosition(index, "symbol", event.target.value)} placeholder="ASSET" /></label>
          <label>Asset type<input value={position.assetType} onChange={event => updatePosition(index, "assetType", event.target.value)} placeholder="CASH / BOND / ..." /></label>
          {decimalInput(position.quantity, value => updatePosition(index, "quantity", value), "Accounting quantity")}
          {decimalInput(position.unitPrice, value => updatePosition(index, "unitPrice", value), "Unit price (USD)")}
          {decimalInput(position.accruedIncome, value => updatePosition(index, "accruedIncome", value), "Accrued income (USD)")}
          <label>Price source<input value={position.priceSource} onChange={event => updatePosition(index, "priceSource", event.target.value)} placeholder="Source/reference" /></label>
          <label>Price observed at<input type="datetime-local" value={position.priceObservedAt} onChange={event => updatePosition(index, "priceObservedAt", event.target.value)} /></label>
          {decimalInput(position.maxPriceAgeSeconds, value => updatePosition(index, "maxPriceAgeSeconds", value), "Max price age (seconds)")}
          {decimalInput(position.custodyQuantity, value => updatePosition(index, "custodyQuantity", value), "Custody quantity")}
          <label>Custody source<input value={position.custodySource} onChange={event => updatePosition(index, "custodySource", event.target.value)} placeholder="Statement/reference" /></label>
          <label>Custody as-of<input type="datetime-local" value={position.custodyAsOf} onChange={event => updatePosition(index, "custodyAsOf", event.target.value)} /></label>
        </div>
        {positions.length > 1 && <button className="secondary-button nav-remove-button" type="button" onClick={() => { invalidate(); setPositions(current => current.filter((_, i) => i !== index)); }}>Remove asset</button>}
      </fieldset>)}
    </div>

    <div className="nav-input-section">
      <div className="panel-heading"><div><span className="eyebrow">LIABILITIES</span><h3>Fund liabilities</h3></div><button className="secondary-button" type="button" onClick={() => { invalidate(); setLiabilities(current => [...current, { description: "", amount: "", source: "", asOf: datetimeLocalNow() }]); }}>Add liability</button></div>
      {liabilities.map((liability, index) => <fieldset className="nav-input-card" key={`liability-${index}`}>
        <legend>Liability {index + 1}</legend>
        <div className="nav-input-grid">
          <label>Description<input value={liability.description} onChange={event => updateLiability(index, "description", event.target.value)} /></label>
          {decimalInput(liability.amount, value => updateLiability(index, "amount", value), "Amount (USD)")}
          <label>Source<input value={liability.source} onChange={event => updateLiability(index, "source", event.target.value)} /></label>
          <label>As of<input type="datetime-local" value={liability.asOf} onChange={event => updateLiability(index, "asOf", event.target.value)} /></label>
        </div>
        <button className="secondary-button nav-remove-button" type="button" onClick={() => { invalidate(); setLiabilities(current => current.filter((_, i) => i !== index)); }}>Remove liability</button>
      </fieldset>)}
    </div>

    <div className="governance-actions">
      <button className="primary-button" type="button" disabled={busy || props.publicationPaused || !props.contractId} onClick={() => void prepareSnapshot()}>
        {busy ? "Working…" : "Calculate & reconcile"}
      </button>
    </div>
    {prepared && <>
      <div className="contract-details nav-preview-grid">
        <Detail label="Gross assets" value={`$${prepared.payload.grossAssets}`} />
        <Detail label="Liabilities" value={`$${prepared.payload.totalLiabilities}`} />
        <Detail label="Net NAV" value={`$${prepared.payload.nav}`} />
        <Detail label="NAV/share" value={`$${prepared.payload.navPerShare}`} />
        <Detail label="Reconciliation" value={prepared.status} />
        <Detail label="Calculation version" value={prepared.payload.calculationVersion} />
        <Detail label="Snapshot hash" value={shortHash(prepared.snapshotHash)} />
        <Detail label="Merkle root" value={shortHash(prepared.merkleRoot)} />
      </div>
      {prepared.checks.map(check => <div className={`check-row ${check.status === "MATCHED" ? "ok-text" : "bad-text"}`} key={check.name}>
        <span className={`check-icon ${check.status === "MATCHED" ? "ok" : "bad"}`}>{check.status === "MATCHED" ? "✓" : "!"}</span>
        <div><b>{check.name}</b><small>{check.message} ({check.expected} / {check.actual})</small></div>
        <span className="check-status">{check.status}</span>
      </div>)}
      <div className="notice">{prepared.provenanceWarning}</div>
    </>}
    {props.publicationPaused && <p className="tx-message">NAV publication is paused by the contract owner.</p>}
    {!props.walletAccount && <small>Connect a wallet with the contract’s approver role, then the publisher role, to submit the two transactions.</small>}
    {props.walletAccount && props.walletAccount !== props.approverId && props.walletAccount !== props.publisherId &&
      <small>This wallet has neither the configured contract approver nor publisher role.</small>}
    <div className="governance-actions">
      <button className="secondary-button" type="button" disabled={!canApprove} onClick={() => void approveSnapshot()}>Approve prepared snapshot</button>
      <button className="wallet-button" type="button" disabled={!canPublish} onClick={() => void publishSnapshot()}>Publish approved NAV</button>
    </div>
    {approved && <p className="tx-message">Approval confirmed for snapshot #{prepared?.context.nextSequence}. Publishing is enabled only for the configured publisher and this exact snapshot.</p>}
    {message && <p className="tx-message" role="status">{message}</p>}
    <small>Approval and publication are on-chain transactions and require wallet confirmation and NEAR gas. No transaction is submitted until you click the corresponding button.</small>
  </section>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-row"><span>{label}</span><b title={value}>{value}</b></div>;
}
