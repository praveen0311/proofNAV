import InvestorLifecycle from "./InvestorLifecycle";
import NavPublicationWorkflow from "./NavPublicationWorkflow";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight, ArrowLeftRight, ArrowUpRight, Blocks, CircleAlert, Clock3,
  Fingerprint, Layers3, RefreshCw, ShieldCheck
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";
import { connectWallet, disconnectWallet, getConnectedAccount, getWalletSelector } from "./near-wallet";
import { CONTRACT_ID, EXPLORER_URL, NETWORK, RPC_URL } from "./near-network";
import "@near-wallet-selector/modal-ui/styles.css";

const SUPPLY_SCALE = 100_000_000;
const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";

type NavRecord = {
  sequence: number;
  valuation_timestamp: number | string;
  nav_minor_units: string;
  nav_per_share: string;
  share_supply: string;
  currency: string;
  merkle_root: string;
  snapshot_hash: string;
  reconciliation_status: string;
  previous_snapshot_hash: string | null;
  calculation_version: string;
  publisher_id: string;
  published_at: number | string;
};

type FungibleTokenMetadata = {
  spec: string;
  name: string;
  symbol: string;
  decimals: number;
};

type ContractData = {
  fundId: string;
  publisherId: string;
  approverId: string;
  publicationPaused: boolean;
  totalSupply: string;
  metadata: FungibleTokenMetadata;
  history: NavRecord[];
};

type RpcResponse = {
  result?: { result?: number[] };
  error?: { message?: string; data?: string };
};

const DEMO_DATA: ContractData = {
  fundId: "PROOFNAV-DEMO-001",
  publisherId: "blockmintlabs.testnet",
  approverId: "blockmintlabs.testnet",
  publicationPaused: false,
  totalSupply: "100000000000000",
  metadata: { spec: "ft-1.0.0", name: "ProofNAV Share", symbol: "PNAV", decimals: 8 },
  history: [
    {
      sequence: 1,
      valuation_timestamp: 1794441600,
      nav_minor_units: "123000000",
      nav_per_share: "123000000",
      share_supply: "100000000000000",
      currency: "USD",
      merkle_root: "b2".repeat(32),
      snapshot_hash: "a1".repeat(32),
      reconciliation_status: "MATCHED",
      previous_snapshot_hash: null,
      calculation_version: "demo-nav-v1",
      publisher_id: "blockmintlabs.testnet",
      published_at: 1794441600,
    },
    {
      sequence: 2,
      valuation_timestamp: 1794528000,
      nav_minor_units: "124000000",
      nav_per_share: "124000000",
      share_supply: "100000000000000",
      currency: "USD",
      merkle_root: "d4".repeat(32),
      snapshot_hash: "c3".repeat(32),
      reconciliation_status: "MATCHED",
      previous_snapshot_hash: "a1".repeat(32),
      calculation_version: "demo-nav-v1",
      publisher_id: "blockmintlabs.testnet",
      published_at: 1794528000,
    },
    {
      sequence: 3,
      valuation_timestamp: 1794614400,
      nav_minor_units: "125000000",
      nav_per_share: "125000000",
      share_supply: "100000000000000",
      currency: "USD",
      merkle_root: "f6".repeat(32),
      snapshot_hash: "e5".repeat(32),
      reconciliation_status: "MATCHED",
      previous_snapshot_hash: "c3".repeat(32),
      calculation_version: "demo-nav-v1",
      publisher_id: "blockmintlabs.testnet",
      published_at: 1794614400,
    },
  ],
};

const shortHash = (value?: string | null) =>
  value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";

function formatMoney(value: number, currency = "USD", maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits
  }).format(value);
}

function formatCompactNav(value: number) {
  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 1_000_000_000) return `$${(value / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}B`;
  if (absoluteValue >= 1_000_000) return `$${(value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (absoluteValue >= 1_000) return `$${(value / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  return formatMoney(value);
}

function navAmount(record: NavRecord) {
  return Number(record.nav_minor_units) / 100;
}

function navPerShare(record: NavRecord) {
  return Number(record.nav_per_share) / SUPPLY_SCALE;
}

function tokenAmount(value: string) {
  return Number(value) / SUPPLY_SCALE;
}

function formatTimestamp(value: number | string) {
  const timestamp = Number(value);
  const milliseconds = timestamp > 100_000_000_000_000
    ? timestamp / 1_000_000
    : timestamp > 100_000_000_000
      ? timestamp
      : timestamp * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function encodeArgs(args: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}

async function viewFunction<T>(methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!CONTRACT_ID) {
    throw new Error("Set VITE_NEAR_CONTRACT_ID to your deployed testnet contract account.");
  }
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `proofnav-${methodName}`,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT_ID,
        method_name: methodName,
        args_base64: encodeArgs(args)
      }
    })
  });
  if (!response.ok) throw new Error(`NEAR RPC request failed (${response.status})`);
  const result = await response.json() as RpcResponse;
  if (result.error) {
    throw new Error(result.error.data || result.error.message || `NEAR RPC failed for ${methodName}`);
  }
  if (!result.result?.result) throw new Error(`NEAR RPC returned no result for ${methodName}`);
  const bytes = new Uint8Array(result.result.result);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function loadContractData(): Promise<ContractData> {
  const [fundId, publisherId, approverId, publicationPaused, totalSupply, metadata, latest] =
    await Promise.all([
      viewFunction<string>("get_fund_id"),
      viewFunction<string>("get_publisher_id"),
      viewFunction<string>("get_approver_id"),
      viewFunction<boolean>("is_publication_paused"),
      viewFunction<string>("ft_total_supply"),
      viewFunction<FungibleTokenMetadata>("ft_metadata"),
      viewFunction<NavRecord | null>("get_latest_nav")
    ]);
  const firstSequence = latest ? Math.max(1, latest.sequence - 99) : 1;
  const history = await viewFunction<NavRecord[]>("get_nav_history", {
    from_sequence: firstSequence,
    limit: 100
  });

  return {
    fundId,
    publisherId,
    approverId,
    publicationPaused,
    totalSupply,
    metadata,
    history
  };
}

export default function App() {
  const [data, setData] = useState<ContractData | null>(DEMO_MODE ? DEMO_DATA : null);
  const [loading, setLoading] = useState(!DEMO_MODE);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"overview" | "portfolio" | "proof" | "investor">("overview");
  const [walletAccount, setWalletAccount] = useState<string | null>(null);
  const [txMessage, setTxMessage] = useState("");

  const load = useCallback(async () => {
    if (DEMO_MODE) {
      setData(DEMO_DATA);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setData(await loadContractData());
    } catch (reason) {
      setData(null);
      setError(
        reason instanceof TypeError && /fetch/i.test(reason.message)
          ? `NEAR testnet RPC at ${RPC_URL} is unreachable. Check your internet connection, then retry.`
          : reason instanceof Error ? reason.message : String(reason)
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const selector = await getWalletSelector();
        const sync = async () => {
          const account = await getConnectedAccount();
          if (active) setWalletAccount(account);
        };
        await sync();
        const subscription = selector.store.observable.subscribe(() => { void sync(); });
        if (active) (window as any).__proofnavWalletSub = subscription;
      } catch (e) {
        if (active) setTxMessage(`Wallet initialization failed: ${(e as Error).message}`);
      }
    })();
    return () => { active = false; (window as any).__proofnavWalletSub?.unsubscribe?.(); };
  }, []);

  const history = data?.history ?? [];
  const latest = history[history.length - 1] ?? null;
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const change = latest && previous && navAmount(previous) !== 0
    ? ((navAmount(latest) - navAmount(previous)) / navAmount(previous)) * 100
    : null;
  const trend = useMemo(() => history.map(record => ({
    label: `#${record.sequence}`,
    nav: navAmount(record)
  })), [history]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Fingerprint size={22}/></div><div><b>ProofNAV</b><small>VALUATION PROTOCOL</small></div></div>
      <div className="network"><span className="pulse"/> {DEMO_MODE ? "DEMO · SAMPLE DATA" : `NEAR ${NETWORK.toUpperCase()} · ON-CHAIN READS`}</div>
      <div className="nav-label">WORKSPACE</div>
      <button className={`nav-item ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}><Layers3 size={17}/> Overview</button>
      <button className={`nav-item ${tab === "portfolio" ? "active" : ""}`} onClick={() => setTab("portfolio")}><Blocks size={17}/> Portfolio</button>
      <button className={`nav-item ${tab === "proof" ? "active" : ""}`} onClick={() => setTab("proof")}><ShieldCheck size={17}/> On-chain proof</button>
      <button className={`nav-item ${tab === "investor" ? "active" : ""}`} onClick={() => setTab("investor")}><ArrowLeftRight size={17}/> Subscribe & redeem</button>
      <div className="sidebar-bottom">
        <div className="security-card"><ShieldCheck size={17}/><b>Live contract reads</b><p>Fund, token and published NAV data are fetched from the configured NEAR network.</p></div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div><div className="eyebrow">{DEMO_MODE ? "DEMO PREVIEW · NOT ON-CHAIN" : `NEAR ${NETWORK.toUpperCase()} / ${CONTRACT_ID}`}</div><h1>{tab === "overview" ? "Fund overview" : tab === "portfolio" ? "Portfolio" : tab === "proof" ? "On-chain proof" : "Subscribe & redeem"}</h1></div>
        <div className="top-actions">
          <span className="testnet-pill"><span/> {DEMO_MODE ? "DEMO · NOT ON-CHAIN" : `${NETWORK.toUpperCase()} · ${data ? "CONNECTED" : loading ? "CONNECTING" : error ? "RPC OFFLINE" : "DISCONNECTED"}`}</span>
          <button className="icon-button" title="Refresh on-chain data" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={17}/></button>
          {!DEMO_MODE && (walletAccount ? <button className="wallet-button" onClick={() => void disconnectWallet().then(() => setWalletAccount(null))}>{walletAccount}</button> : <button className="wallet-button" onClick={() => void connectWallet()}>Connect NEAR wallet</button>)}
          {!DEMO_MODE && EXPLORER_URL && <a className="wallet-button explorer-link" href={EXPLORER_URL} target="_blank" rel="noreferrer">View contract</a>}
        </div>
      </header>

      {DEMO_MODE && <div className="toast"><CircleAlert size={16}/><span>Sample figures for a screenshot only. They are not verified or published on NEAR.</span></div>}
      {error && <div className="toast toast-error"><CircleAlert size={16}/><span>Could not read contract data: {error}</span><button onClick={() => void load()}>Retry</button></div>}

      {loading && !data && !error && <section className="panel loading-panel"><RefreshCw className="spin" size={18}/> Connecting to {CONTRACT_ID} on {NETWORK}…</section>}

      {data && <div className="contract-banner"><span>{DEMO_MODE ? "Demo dataset" : "Connected contract"}</span>{DEMO_MODE ? <span>Sample only · no on-chain changes</span> : EXPLORER_URL ? <a href={EXPLORER_URL} target="_blank" rel="noreferrer">{CONTRACT_ID}</a> : <span>{CONTRACT_ID}</span>}<span>Fund: <b>{data.fundId}</b></span><span className={`pill ${data.publicationPaused ? "pill-warn" : "pill-good"}`}>{DEMO_MODE ? "SAMPLE DATA" : data.publicationPaused ? "PUBLICATION PAUSED" : "PUBLICATION ACTIVE"}</span></div>}

      {tab === "overview" && <>
          <section className="hero-row">
            <div className="hero-card">
              <div className="card-top"><span className="eyebrow light">{DEMO_MODE ? "LATEST SAMPLE NAV" : "LATEST ON-CHAIN NAV"}</span><span className="live-dot">● {DEMO_MODE ? "DEMO DATA" : !data ? "DATA UNAVAILABLE" : latest ? `SEQUENCE #${latest.sequence}` : "NO PUBLICATIONS"}</span></div>
              <div className="hero-value">{latest ? formatMoney(navAmount(latest), latest.currency) : "—"}</div>
              <div className="hero-meta">{change === null ? <span>{data ? "No prior on-chain NAV for comparison" : "Live NAV unavailable until local RPC reconnects"}</span> : <><span className={change >= 0 ? "positive" : "negative"}>{change >= 0 ? <ArrowUpRight size={15}/> : <ArrowDownRight size={15}/>} {Math.abs(change).toFixed(2)}%</span><span>vs previous on-chain record</span></>}</div>
              <div className="hero-footer"><div><small>NAV PER SHARE</small><b>{latest ? formatMoney(navPerShare(latest), latest.currency, 8) : "—"}</b></div><div><small>SEQUENCE</small><b>{latest ? `#${latest.sequence}` : "—"}</b></div><div><small>VALUATION TIME</small><b>{latest ? formatTimestamp(latest.valuation_timestamp) : "—"}</b></div></div>
            </div>
            <div className="status-card">
              <div className="card-heading"><div><span className="eyebrow">CONTRACT STATUS</span><h3>On-chain controls</h3></div><ShieldCheck size={20}/></div>
              <div className="status-center"><div className={`status-ring ${latest?.reconciliation_status === "MATCHED" ? "ring-good" : "ring-warn"}`}><span>{latest?.reconciliation_status === "MATCHED" ? "✓" : "!"}</span></div><div><b>{!data ? "UNAVAILABLE" : latest?.reconciliation_status || "NO NAV"}</b><small>{DEMO_MODE ? "Illustrative sample status · not on-chain" : latest ? "Status from latest published contract record" : data ? "No NAV has been published on this contract" : "Connect the NEAR RPC to read contract status"}</small></div></div>
              <div className="status-foot"><span>Publisher</span><b>{data?.publisherId || "—"}</b></div>
              <div className="status-foot"><span>Approver</span><b>{data?.approverId || "—"}</b></div>
            </div>
          </section>

          <section className="metrics-grid">
            <Metric title={DEMO_MODE ? "Sample share supply" : "On-chain share supply"} value={data ? Number(tokenAmount(data.totalSupply)).toLocaleString("en-US") : "—"} sub={data ? `${data.metadata.symbol} · ${data.metadata.decimals} decimals` : "Waiting for testnet contract data"} icon={<Blocks/>}/>
            <Metric title="Fund identifier" value={data?.fundId || "—"} sub={data ? "Read from contract state" : "Unavailable while RPC is offline"} icon={<Layers3/>}/>
            <Metric title={DEMO_MODE ? "Sample sequence" : "Latest sequence"} value={latest ? `#${latest.sequence}` : data ? "None" : "—"} sub={latest ? `Published by ${latest.publisher_id}` : data ? "No published NAV" : "Waiting for testnet contract data"} icon={<ShieldCheck/>}/>
            <Metric title={DEMO_MODE ? "Sample commitment" : "Snapshot commitment"} value={latest ? shortHash(latest.snapshot_hash) : data ? "None" : "—"} sub={data ? DEMO_MODE ? "Illustrative hash · not stored on-chain" : "Stored in the latest on-chain record" : "Waiting for testnet contract data"} icon={<Fingerprint/>}/>
          </section>

          <section className="content-grid">
            <div className="panel chart-panel"><div className="panel-heading"><div><span className="eyebrow">{DEMO_MODE ? "ILLUSTRATIVE HISTORY" : "ON-CHAIN HISTORY"}</span><h3>{DEMO_MODE ? "Sample NAV" : "Published NAV"}</h3></div><span className="subtle-tag">USD</span></div>
              {trend.length ? <ResponsiveContainer width="100%" height={245}><AreaChart data={trend} margin={{top:12,right:12,left:0,bottom:0}}><defs><linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8b9cff" stopOpacity={.28}/><stop offset="95%" stopColor="#8b9cff" stopOpacity={0}/></linearGradient></defs><CartesianGrid stroke="#222b40" vertical={false}/><XAxis dataKey="label" stroke="#7e8aa5" tickLine={false} axisLine={false}/><YAxis stroke="#7e8aa5" tickLine={false} axisLine={false} tickFormatter={formatCompactNav}/><Tooltip contentStyle={{background:"#111a2c",border:"1px solid #2a3650",borderRadius:10}} formatter={(value: number) => [formatMoney(value), "NAV"]}/><Area type="monotone" dataKey="nav" stroke="#9aa9ff" strokeWidth={2.5} fill="url(#navFill)"/></AreaChart></ResponsiveContainer> : <Empty text={data ? "No NAV records are published on this contract yet." : "NAV history will appear here when the local NEAR RPC is available."}/>}
            </div>
            <div className="panel allocation-panel"><div className="panel-heading"><div><span className="eyebrow">TOKEN CONTRACT</span><h3>{data?.metadata.name || "Contract details"}</h3></div></div><div className="contract-details"><Detail label="Token symbol" value={data?.metadata.symbol || "—"}/><Detail label="Total supply" value={data ? `${Number(tokenAmount(data.totalSupply)).toLocaleString("en-US")} ${data.metadata.symbol}` : "—"}/><Detail label="Contract account" value={CONTRACT_ID || "Not configured"}/><Detail label="Network" value={NETWORK}/></div></div>
          </section>
          <section className="panel action-panel"><div><span className="eyebrow">{DEMO_MODE ? "SCREENSHOT PREVIEW" : "LIVE TESTNET DATA"}</span><h3>{DEMO_MODE ? "Illustrative sample data" : "Connected directly to NEAR"}</h3><p>{DEMO_MODE ? "These sample records are for visual demonstration only; they are not published or verified on-chain." : "This overview shows published NAV, token supply, roles and status. Use On-chain proof to prepare a NAV snapshot, or Subscribe & redeem for investor actions."}</p></div>{!DEMO_MODE && EXPLORER_URL && <a className="secondary-button explorer-link" href={EXPLORER_URL} target="_blank" rel="noreferrer">Open contract explorer</a>}</section>
        </>}

      {tab === "portfolio" && <section className="panel unavailable-panel"><div className="panel-heading"><div><span className="eyebrow">PORTFOLIO DATA</span><h3>Underlying holdings are not on-chain</h3></div><Blocks size={21}/></div><p>The deployed contract exposes the fund share token and published NAV commitments. It does not expose portfolio positions, asset prices, liabilities, or custody balances, so this dashboard does not display synthetic substitutes.</p>{data ? <div className="contract-details"><Detail label="Fund ID" value={data.fundId}/><Detail label="Share token" value={`${data.metadata.name} (${data.metadata.symbol})`}/><Detail label="On-chain total supply" value={`${Number(tokenAmount(data.totalSupply)).toLocaleString("en-US")} ${data.metadata.symbol}`}/></div> : <Empty text="Connect to the local NEAR RPC to load fund details."/>}</section>}

      {tab === "investor" && (DEMO_MODE
        ? <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DEMO PREVIEW</span><h3>Investor actions disabled</h3></div></div><p>Subscribe and redeem actions are unavailable in screenshot mode. Remove <code>?demo=1</code> to connect a testnet wallet.</p></section>
        : <InvestorLifecycle />)}

      {tab === "proof" && <>
        {data && !DEMO_MODE && <NavPublicationWorkflow
          contractId={CONTRACT_ID}
          fundId={data.fundId}
          totalSupply={data.totalSupply}
          latestSequence={latest?.sequence ?? 0}
          approverId={data.approverId}
          publisherId={data.publisherId}
          walletAccount={walletAccount}
          publicationPaused={data.publicationPaused}
          onPublished={load}
        />}
        <section className="panel proof-panel"><div className="panel-heading"><div><span className="eyebrow">AUDIT TRAIL</span><h3>Latest published commitment</h3></div><Fingerprint size={21}/></div>{latest ? <><Hash label="SNAPSHOT HASH · SHA-256" value={latest.snapshot_hash}/><Hash label="MERKLE ROOT" value={latest.merkle_root}/><div className="contract-details proof-details"><Detail label="Sequence" value={String(latest.sequence)}/><Detail label="Reconciliation" value={latest.reconciliation_status}/><Detail label="Publisher" value={latest.publisher_id}/><Detail label="Calculation version" value={latest.calculation_version}/><Detail label="Previous snapshot" value={latest.previous_snapshot_hash || "First published snapshot"}/><Detail label="Published at" value={formatTimestamp(latest.published_at)}/></div></> : <Empty text={data ? "No on-chain NAV commitment is available yet." : "Commitment details will appear when the local NEAR RPC is available."}/>}</section>
      </>}

      {tab === "overview" && <section className="panel history-panel"><div className="panel-heading"><div><span className="eyebrow">IMMUTABLE ON-CHAIN RECORDS</span><h3>NAV history</h3></div><span className="subtle-tag">{history.length} RECORDS</span></div>{history.length ? <div className="table-wrap"><table><thead><tr><th>SEQUENCE</th><th>VALUATION TIME</th><th>NAV</th><th>RECONCILIATION</th><th>HASH</th><th>PUBLISHER</th></tr></thead><tbody>{[...history].reverse().map(record=><tr key={record.sequence}><td><b>#{record.sequence}</b></td><td>{formatTimestamp(record.valuation_timestamp)}</td><td><b>{formatMoney(navAmount(record), record.currency)}</b></td><td><span className={`pill ${record.reconciliation_status === "MATCHED" ? "pill-good" : "pill-warn"}`}>{record.reconciliation_status}</span></td><td><code>{shortHash(record.snapshot_hash)}</code></td><td>{record.publisher_id}</td></tr>)}</tbody></table></div> : <Empty text={data ? "No NAV records have been published on this contract." : "History is unavailable until the local NEAR RPC connects."}/>}</section>}

      <footer>ProofNAV · NEAR {NETWORK} contract view <span>On-chain read-only data · No synthetic holdings</span></footer>
    </main>
  </div>;
}

function Metric({title,value,sub,icon}:{title:string;value:string;sub:string;icon:React.ReactNode}) {
  return <div className="metric-card"><div className="metric-top"><span>{title}</span><i>{icon}</i></div><b>{value}</b><small>{sub}</small></div>;
}

function Detail({label,value}:{label:string;value:string}) {
  return <div className="detail-row"><span>{label}</span><b>{value}</b></div>;
}

function Hash({label,value}:{label:string;value:string}) {
  return <div className="hash-row"><div><small>{label}</small><code>{value}</code></div><button onClick={() => void navigator.clipboard.writeText(value)}>Copy</button></div>;
}

function Empty({text}:{text:string}) {
  return <div className="empty"><Clock3 size={22}/><p>{text}</p></div>;
}
