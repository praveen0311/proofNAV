import { Router } from "express";
import Decimal from "decimal.js";
import { z } from "zod";
import { canonicalJson, merkleRoot, sha256 } from "./crypto";
import { lifecycleConfig, viewCall } from "./lifecycle";

const amount = z.string().regex(/^\d+(?:\.\d+)?$/).max(40);
const identifier = z.string().trim().min(1).max(128);
const isoDate = z.string().datetime({ offset: true });
const PreciseDecimal = Decimal.clone({ precision: 80 });

function assertScale(value: InstanceType<typeof PreciseDecimal>, scale: number, label: string) {
  if (value.decimalPlaces() > scale) throw new Error(`${label} supports at most ${scale} decimal places`);
}

const snapshotInput = z.object({
  contractId: identifier,
  valuationTimestamp: isoDate,
  calculationVersion: identifier,
  positions: z.array(z.object({
    assetId: identifier,
    symbol: identifier,
    assetType: identifier,
    quantity: amount,
    unitPrice: amount,
    accruedIncome: amount,
    priceSource: identifier,
    priceObservedAt: isoDate,
    maxPriceAgeSeconds: z.number().int().positive().max(31_536_000),
    custodyQuantity: amount,
    custodySource: identifier,
    custodyAsOf: isoDate,
  }).strict()).min(1).max(100),
  liabilities: z.array(z.object({
    id: identifier,
    description: identifier,
    amount,
    source: identifier,
    asOf: isoDate,
  }).strict()).max(100),
}).strict();

export const navSnapshotRouter = Router();

async function getChainContext() {
  const [fundId, publisherId, approverId, publicationPaused, totalSupply, latest] = await Promise.all([
    viewCall<string>(lifecycleConfig.contractId, "get_fund_id"),
    viewCall<string>(lifecycleConfig.contractId, "get_publisher_id"),
    viewCall<string>(lifecycleConfig.contractId, "get_approver_id"),
    viewCall<boolean>(lifecycleConfig.contractId, "is_publication_paused"),
    viewCall<string>(lifecycleConfig.contractId, "ft_total_supply"),
    viewCall<Record<string, unknown> | null>(lifecycleConfig.contractId, "get_latest_nav"),
  ]);
  if (!/^\d+$/.test(totalSupply) || BigInt(totalSupply) <= 0n) {
    throw new Error("Contract returned an invalid share supply");
  }
  const latestSequence = latest ? Number(latest.sequence) : 0;
  if (!Number.isSafeInteger(latestSequence) || latestSequence < 0) {
    throw new Error("Contract returned an invalid NAV sequence");
  }
  return {
    network: lifecycleConfig.network,
    contractId: lifecycleConfig.contractId,
    fundId,
    publisherId,
    approverId,
    publicationPaused,
    totalSupply,
    latestSequence,
    nextSequence: latestSequence + 1,
  };
}

navSnapshotRouter.get("/context", async (_req, res) => {
  try {
    res.json(await getChainContext());
  } catch (error) {
    res.status(502).json({ error: `Could not read the configured NEAR contract: ${(error as Error).message}` });
  }
});

navSnapshotRouter.post("/prepare", async (req, res) => {
  const parsed = snapshotInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid NAV snapshot inputs", details: parsed.error.flatten() });
  }

  try {
    const input = parsed.data;
    const context = await getChainContext();
    if (input.contractId !== context.contractId) {
      return res.status(409).json({ error: `Snapshot contract must match configured contract ${context.contractId}` });
    }
    if (context.publicationPaused) {
      return res.status(409).json({ error: "NAV publication is paused on the configured contract" });
    }
    const valuationTime = Date.parse(input.valuationTimestamp);
    if (valuationTime > Date.now()) throw new Error("Valuation cut time cannot be in the future");
    const checks: Array<{ name: string; status: "MATCHED" | "FAILED"; expected: string; actual: string; message: string }> = [];
    const positions = input.positions.map((position, index) => {
      const quantity = new PreciseDecimal(position.quantity);
      const unitPrice = new PreciseDecimal(position.unitPrice);
      const accrued = new PreciseDecimal(position.accruedIncome);
      const custodyQuantity = new PreciseDecimal(position.custodyQuantity);
      if (!quantity.isFinite() || quantity.lte(0)) throw new Error(`Position ${position.symbol}: quantity must be positive`);
      if (!unitPrice.isFinite() || unitPrice.lte(0)) throw new Error(`Position ${position.symbol}: price must be positive`);
      if (!accrued.isFinite() || accrued.lt(0)) throw new Error(`Position ${position.symbol}: accrued income cannot be negative`);
      if (!custodyQuantity.isFinite() || custodyQuantity.lt(0)) throw new Error(`Position ${position.symbol}: custody quantity cannot be negative`);
      assertScale(quantity, 18, `Position ${position.symbol} quantity`);
      assertScale(unitPrice, 8, `Position ${position.symbol} unit price`);
      assertScale(accrued, 2, `Position ${position.symbol} accrued income`);
      assertScale(custodyQuantity, 18, `Position ${position.symbol} custody quantity`);

      const priceTime = Date.parse(position.priceObservedAt);
      const custodyTime = Date.parse(position.custodyAsOf);
      if (priceTime > valuationTime) throw new Error(`Position ${position.symbol}: price observation is after the valuation time`);
      if (Math.floor((valuationTime - priceTime) / 1000) > position.maxPriceAgeSeconds) {
        throw new Error(`Position ${position.symbol}: price observation is stale`);
      }
      if (custodyTime > valuationTime) throw new Error(`Position ${position.symbol}: custody balance is after the valuation time`);

      const matched = quantity.eq(custodyQuantity);
      checks.push({
        name: `CUSTODY_${index + 1}_${position.symbol}`,
        status: matched ? "MATCHED" : "FAILED",
        expected: quantity.toString(),
        actual: custodyQuantity.toString(),
        message: matched ? `${position.symbol} accounting quantity equals the entered custody quantity` : `${position.symbol} accounting and custody quantities differ`,
      });

      return {
        positionId: `position-${index + 1}`,
        assetId: position.assetId,
        symbol: position.symbol,
        assetType: position.assetType,
        quantity: quantity.toFixed(18),
        unitPrice: unitPrice.toFixed(8),
        accruedIncome: accrued.toFixed(2),
        marketValue: quantity.mul(unitPrice).plus(accrued).toFixed(2),
        priceSource: position.priceSource,
        priceObservedAt: position.priceObservedAt,
        custodyQuantity: custodyQuantity.toFixed(18),
        custodySource: position.custodySource,
        custodyAsOf: position.custodyAsOf,
      };
    });

    const supplyShares = new PreciseDecimal(context.totalSupply).div(100_000_000);
    const checksSupply = {
      name: "ONCHAIN_SHARE_SUPPLY",
      status: "MATCHED" as const,
      expected: context.totalSupply,
      actual: context.totalSupply,
      message: `Using live total supply from ${context.contractId}`,
    };
    checks.push(checksSupply);

    const liabilities = input.liabilities.map((liability, index) => {
      const value = new PreciseDecimal(liability.amount);
      if (!value.isFinite() || value.lt(0)) throw new Error(`Liability ${liability.description}: amount cannot be negative`);
      assertScale(value, 2, `Liability ${liability.description} amount`);
      if (Date.parse(liability.asOf) > valuationTime) throw new Error(`Liability ${liability.description}: as-of time is after the valuation time`);
      return {
        id: `liability-${index + 1}`,
        description: liability.description,
        amount: value.toFixed(2),
        source: liability.source,
        asOf: liability.asOf,
      };
    });

    const grossAssets = positions.reduce((sum, position) => sum.plus(position.marketValue), new PreciseDecimal(0)).toDecimalPlaces(2);
    const totalLiabilities = liabilities.reduce((sum, liability) => sum.plus(liability.amount), new PreciseDecimal(0)).toDecimalPlaces(2);
    const nav = grossAssets.minus(totalLiabilities).toDecimalPlaces(2);
    if (nav.lte(0)) throw new Error("Net NAV must be positive");
    const navCentsDecimal = nav.mul(100);
    if (!navCentsDecimal.isInteger()) throw new Error("NAV must resolve to whole USD cents");
    const navMinorUnits = BigInt(navCentsDecimal.toFixed(0));
    const shareSupplyRaw = BigInt(context.totalSupply);
    const maxU128 = (1n << 128n) - 1n;
    if (navMinorUnits > maxU128 || navMinorUnits * 100_000_000_000_000n > maxU128) {
      throw new Error("NAV exceeds the NEAR contract's supported U128 range");
    }
    const navPerShareRaw = navMinorUnits * 100_000_000_000_000n / shareSupplyRaw;
    if (navPerShareRaw <= 0n) throw new Error("NAV per share rounds to zero at contract precision");

    const matched = checks.every(check => check.status === "MATCHED");
    const payload = {
      fundId: context.fundId,
      sequence: context.nextSequence,
      valuationTimestamp: input.valuationTimestamp,
      currency: "USD",
      positions,
      liabilities,
      grossAssets: grossAssets.toFixed(2),
      totalLiabilities: totalLiabilities.toFixed(2),
      nav: nav.toFixed(2),
      eligibleShares: supplyShares.toFixed(18),
      navPerShare: new PreciseDecimal(navPerShareRaw.toString()).div(100_000_000).toFixed(8),
      reconciliationStatus: matched ? "MATCHED" : "FAILED",
      calculationVersion: input.calculationVersion,
    };
    const root = merkleRoot([...positions, ...liabilities]);
    const snapshotHash = sha256(canonicalJson({ ...payload, merkleRoot: root }));
    res.json({
      dataMode: "OPERATOR_ENTERED",
      provenanceWarning: "Values and source labels were entered by the operator and were not independently verified by the API.",
      context,
      checks,
      status: payload.reconciliationStatus,
      snapshotHash,
      merkleRoot: root,
      payload,
      onChainArgs: {
        sequence: context.nextSequence,
        valuation_timestamp: Math.floor(valuationTime / 1000),
        nav_minor_units: navMinorUnits.toString(),
        nav_per_share: navPerShareRaw.toString(),
        expected_share_supply: context.totalSupply,
        currency: "USD",
        merkle_root: root,
        snapshot_hash: snapshotHash,
        reconciliation_status: payload.reconciliationStatus,
        calculation_version: input.calculationVersion,
      },
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});
