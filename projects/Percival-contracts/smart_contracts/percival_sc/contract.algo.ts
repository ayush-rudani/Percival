import type { gtxn, uint64 } from "@algorandfoundation/algorand-typescript";
import {
  abimethod,
  Account,
  assert,
  Contract,
  Global,
  GlobalState,
  itxn,
  Txn,
  arc4,
  BoxMap,
} from "@algorandfoundation/algorand-typescript";

/**
 * PercivalSc - Content Prediction Market
 *
 * Users can create a market tied to a piece of content (e.g., Instagram/TikTok post) with a target count
 * (likes/views/etc.) and a deadline. Others place YES/NO bets using microAlgos via grouped payment.
 * After the deadline, a designated oracle resolves the market by submitting the final observed count.
 * Winners can settle their individual bets to receive their stake plus proportional winnings from the losing pool.
 *
 * Notes:
 * - Uses BoxMap for scalable storage of markets and per-bet records.
 * - GlobalState counters for sequential IDs.
 * - Settlement is per-bet to avoid unbounded loops in a single transaction.
 */

/** Market definition */
class MarketStruct extends arc4.Struct<{
  platform: arc4.Str; // e.g., "instagram", "tiktok"
  contentId: arc4.Str; // external content ref (URL or ID)
  targetCount: arc4.UintN64; // threshold to compare against
  deadline: arc4.UintN64; // unix timestamp (seconds)
  resolved: arc4.Bool;
  finalCount: arc4.UintN64; // set by oracle at resolution
  creator: arc4.Address; // market creator
  oracle: arc4.Address; // allowed resolver
  feeBps: arc4.UintN64; // protocol/creator fee in basis points (1/100 of %)
  totalYesStake: arc4.UintN64;
  totalNoStake: arc4.UintN64;
  collectedFees: arc4.UintN64; // accumulated, withdrawable by creator
}> {}

/** Individual bet record */
class BetStruct extends arc4.Struct<{
  marketId: arc4.UintN64;
  bettor: arc4.Address;
  sideYes: arc4.Bool; // true => YES, false => NO
  amount: arc4.UintN64; // staked microAlgos
  settled: arc4.Bool; // has this bet been settled/payout claimed
}> {}

export class PercivalSc extends Contract {
  // Incrementing IDs
  public nextMarketId = GlobalState<uint64>({ key: "nextMarketId" });
  public nextBetId = GlobalState<uint64>({ key: "nextBetId" });

  // Storage
  public markets = BoxMap<uint64, MarketStruct>({ keyPrefix: "markets" });
  public bets = BoxMap<uint64, BetStruct>({ keyPrefix: "bets" });

  /**
   * Create a new prediction market.
   *
   * @param platform Social platform label (e.g., "instagram")
   * @param contentId Content reference (URL or platform-specific ID)
   * @param targetCount Target count to compare against at resolution
   * @param deadline Unix timestamp after which no more bets are allowed
   * @param oracle Address allowed to resolve with the final observed count
   * @param feeBps Fee in basis points (e.g., 100 = 1%) taken from winners' profits
   * @returns marketId
   */
  @abimethod()
  public createMarket(platform: string, contentId: string, targetCount: uint64, deadline: uint64, oracle: Account, feeBps: uint64): uint64 {
    // Basic validation
    assert(feeBps <= 1000, "fee too high"); // cap at 10%
    assert(deadline > Global.latestTimestamp, "deadline in past");

    const id = this.nextMarketId.value;

    const m = new MarketStruct({
      platform: new arc4.Str(platform),
      contentId: new arc4.Str(contentId),
      targetCount: new arc4.UintN64(targetCount),
      deadline: new arc4.UintN64(deadline),
      resolved: new arc4.Bool(false),
      finalCount: new arc4.UintN64(0),
      creator: new arc4.Address(Txn.sender),
      oracle: new arc4.Address(oracle),
      feeBps: new arc4.UintN64(feeBps),
      totalYesStake: new arc4.UintN64(0),
      totalNoStake: new arc4.UintN64(0),
      collectedFees: new arc4.UintN64(0),
    });

    this.markets(id).value = m.copy();
    this.nextMarketId.value = id + 1;
    return id;
  }

  /**
   * Place a YES/NO bet by grouping a payment transaction to the app address.
   *
   * @param marketId The market to bet on
   * @param sideYes true for YES (finalCount >= targetCount), false for NO
   * @param amount Amount to stake (microAlgos); must match grouped payment
   * @param payment Grouped payment txn with receiver = app address, sender = caller
   * @returns betId
   */
  @abimethod()
  public placeBet(marketId: uint64, sideYes: boolean, amount: uint64, payment: gtxn.PaymentTxn): uint64 {
    assert(this.markets(marketId).exists, "market not found");
    const m = this.markets(marketId).value.copy();

    // Check not resolved and before deadline
    assert(!m.resolved.native, "market resolved");
    assert(Global.latestTimestamp <= m.deadline.native, "betting closed");

    // Validate grouped payment
    assert(amount > 0, "amount=0");
    assert(payment.amount === amount, "bad amount");
    assert(payment.receiver === Global.currentApplicationAddress, "bad receiver");
    assert(payment.sender === Txn.sender, "bad sender");

    // Record bet
    const betId = this.nextBetId.value;
    const b = new BetStruct({
      marketId: new arc4.UintN64(marketId),
      bettor: new arc4.Address(Txn.sender),
      sideYes: new arc4.Bool(sideYes),
      amount: new arc4.UintN64(amount),
      settled: new arc4.Bool(false),
    });
    this.bets(betId).value = b.copy();
    this.nextBetId.value = betId + 1;

    // Update aggregates
    let newYes: uint64 = m.totalYesStake.native;
    let newNo: uint64 = m.totalNoStake.native;
    if (sideYes) {
      newYes = newYes + amount;
    } else {
      newNo = newNo + amount;
    }
    const updated = new MarketStruct({
      ...m,
      totalYesStake: new arc4.UintN64(newYes),
      totalNoStake: new arc4.UintN64(newNo),
    });
    this.markets(marketId).value = updated.copy();

    return betId;
  }

  /**
   * Resolve a market by providing the final observed count.
   * Can be called by the configured oracle after the deadline.
   */
  @abimethod()
  public resolveMarket(marketId: uint64, finalCount: uint64): boolean {
    assert(this.markets(marketId).exists, "market not found");
    const m = this.markets(marketId).value.copy();

    assert(Global.latestTimestamp >= m.deadline.native, "too early");
    assert(!m.resolved.native, "already resolved");
    assert(new arc4.Address(Txn.sender).bytes === m.oracle.bytes, "not oracle");

    const updated = new MarketStruct({
      ...m,
      resolved: new arc4.Bool(true),
      finalCount: new arc4.UintN64(finalCount),
    });
    this.markets(marketId).value = updated.copy();
    return true;
  }

  /**
   * Settle an individual bet after resolution and pay out if it won.
   * Anyone can trigger, but funds go to the original bettor.
   * Fee is taken from the profit (not from original stake) and accumulated for the creator.
   */
  @abimethod()
  public settleBet(betId: uint64): boolean {
    assert(this.bets(betId).exists, "bet not found");
    const b = this.bets(betId).value.copy();
    assert(!b.settled.native, "already settled");

    const m = this.markets(b.marketId.native).value.copy();
    assert(m.resolved.native, "not resolved");

    const yesWins = m.finalCount.native >= m.targetCount.native;
    const totalYes: uint64 = m.totalYesStake.native;
    const totalNo: uint64 = m.totalNoStake.native;

    let payout: uint64 = 0 as uint64;
    if ((yesWins && b.sideYes.native) || (!yesWins && !b.sideYes.native)) {
      // Winner: base stake + share of losing pool
      const winnersPool: uint64 = yesWins ? totalYes : totalNo;
      const losersPool: uint64 = yesWins ? totalNo : totalYes;

      if (winnersPool === (0 as uint64)) {
        // Should not happen if someone won; fallback to refund stake
        payout = b.amount.native as uint64;
      } else if (losersPool === (0 as uint64)) {
        // No opposing bets; just refund stake, no fee
        payout = b.amount.native as uint64;
      } else {
        // Pro-rata share from losersPool
        const profit: uint64 = ((b.amount.native * losersPool) / winnersPool) as uint64;
        // Fee on profit
        const TEN_K: uint64 = 10000 as uint64;
        const fee: uint64 = ((profit * m.feeBps.native) / TEN_K) as uint64;
        payout = (b.amount.native + (profit - fee)) as uint64;

        // Accumulate fee to creator bucket
        const newCollected: uint64 = (m.collectedFees.native + fee) as uint64;
        const updatedM1 = new MarketStruct({
          ...m,
          collectedFees: new arc4.UintN64(newCollected),
        });
        this.markets(b.marketId.native).value = updatedM1.copy();
      }

      // Pay winner
      itxn
        .payment({
          amount: payout,
          receiver: b.bettor.bytes,
          fee: 0,
        })
        .submit();
    } else {
      // Loser: no payout
    }

    // Mark as settled
    const updatedB = new BetStruct({ ...b, settled: new arc4.Bool(true) });
    this.bets(betId).value = updatedB.copy();
    return true;
  }

  /**
   * Withdraw accumulated fees for a market. Only the market creator.
   */
  @abimethod()
  public withdrawFees(marketId: uint64): boolean {
    assert(this.markets(marketId).exists, "market not found");
    const m = this.markets(marketId).value.copy();
    // Compare addresses by bytes compatibility
    assert(new arc4.Address(Txn.sender).bytes === m.creator.bytes, "not creator");
    const amt = m.collectedFees.native;
    assert(amt > 0, "nothing to withdraw");

    // Zero out fees first to avoid re-entrancy patterns
    const updated = new MarketStruct({ ...m, collectedFees: new arc4.UintN64(0) });
    this.markets(marketId).value = updated.copy();

    itxn.payment({ amount: amt, receiver: m.creator.bytes, fee: 0 }).submit();
    return true;
  }

  /**
   * Read-only: get market details
   */
  @abimethod({ readonly: true })
  public getMarket(marketId: uint64): MarketStruct {
    assert(this.markets(marketId).exists, "market not found");
    return this.markets(marketId).value;
  }

  /**
   * Read-only: get bet details
   */
  @abimethod({ readonly: true })
  public getBet(betId: uint64): BetStruct {
    assert(this.bets(betId).exists, "bet not found");
    return this.bets(betId).value;
  }
}
