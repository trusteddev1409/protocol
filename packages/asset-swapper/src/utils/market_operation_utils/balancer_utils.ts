import { BigNumber } from '@0x/utils';
import { bmath, getPoolsWithTokens, parsePoolData } from '@balancer-labs/sor';
import { Decimal } from 'decimal.js';
import { getAddress } from 'ethers/utils/address';

import { ZERO_AMOUNT } from './constants';

// tslint:disable:boolean-naming

export interface BalancerPool {
    id: string;
    balanceIn: BigNumber;
    balanceOut: BigNumber;
    weightIn: BigNumber;
    weightOut: BigNumber;
    swapFee: BigNumber;
    spotPrice?: BigNumber;
    slippage?: BigNumber;
    limitAmount?: BigNumber;
}

interface CacheValue {
    timestamp: number;
    pools: BalancerPool[];
}

interface BalancerPoolResponse {
    id: string;
    swapFee: string;
    tokens: Array<{ address: string; decimals: number; balance: string }>;
    tokensList: string[];
    totalWeight: string;
}

interface BalancerPoolsResponse {
    pools: BalancerPoolResponse[];
}

// tslint:disable:custom-no-magic-numbers
const FIVE_SECONDS_MS = 5 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 1000;
const MAX_POOLS_FETCHED = 3;
const Decimal20 = Decimal.clone({ precision: 20 });
// tslint:enable:custom-no-magic-numbers

// Following the same override as balancer-sor so it behaves
// similarily
const SUBGRAPH_URL =
    process.env.REACT_APP_SUBGRAPH_URL || 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer';

export class BalancerPoolsCache {
    constructor(
        private readonly _cache: { [key: string]: CacheValue } = {},
        private readonly maxPoolsFetched: number = MAX_POOLS_FETCHED,
    ) {}

    public async getPoolsForPairAsync(
        takerToken: string,
        makerToken: string,
        timeoutMs: number = DEFAULT_TIMEOUT_MS,
    ): Promise<BalancerPool[]> {
        const timeout = new Promise<BalancerPool[]>(resolve => setTimeout(resolve, timeoutMs, []));
        return Promise.race([this._getPoolsForPairAsync(takerToken, makerToken), timeout]);
    }

    public getCachedPoolAddressesForPair(
        takerToken: string,
        makerToken: string,
        cacheExpiryMs?: number,
    ): string[] | undefined {
        const key = JSON.stringify([takerToken, makerToken]);
        const value = this._cache[key];
        if (cacheExpiryMs === undefined) {
            return value === undefined ? [] : value.pools.map(pool => pool.id);
        }
        const minTimestamp = Date.now() - cacheExpiryMs;
        if (value === undefined || value.timestamp < minTimestamp) {
            return undefined;
        } else {
            return value.pools.map(pool => pool.id);
        }
    }

    public howToSampleBalancer(
        takerToken: string,
        makerToken: string,
        isAllowedSource: boolean,
    ): { onChain: boolean; offChain: boolean } {
        // If Balancer is excluded as a source, do not sample.
        if (!isAllowedSource) {
            return { onChain: false, offChain: false };
        }
        const cachedBalancerPools = this.getCachedPoolAddressesForPair(takerToken, makerToken, ONE_DAY_MS);
        // Sample Balancer on-chain (i.e. via the ERC20BridgeSampler contract) if:
        // - Cached values are not stale
        // - There is at least one Balancer pool for this pair
        const onChain = cachedBalancerPools !== undefined && cachedBalancerPools.length > 0;
        // Sample Balancer off-chain (i.e. via GraphQL query + `computeBalancerBuy/SellQuote`)
        // if cached values are stale
        const offChain = cachedBalancerPools === undefined;
        return { onChain, offChain };
    }

    protected async _getPoolsForPairAsync(
        takerToken: string,
        makerToken: string,
        cacheExpiryMs: number = FIVE_SECONDS_MS,
    ): Promise<BalancerPool[]> {
        const key = JSON.stringify([takerToken, makerToken]);
        const value = this._cache[key];
        const minTimestamp = Date.now() - cacheExpiryMs;
        if (value === undefined || value.timestamp < minTimestamp) {
            const timestamp = Date.now();
            // Default
            this._cache[key] = { pools: [], timestamp };
            // Side load all of the pools related to taker token or maker token
            await Promise.all(
                [takerToken, makerToken].map(async token => {
                    const poolsForToken = await this._fetchPoolsForTokenAsync(token);
                    Object.keys(poolsForToken).map(otherToken => {
                        const keyWithOtherToken = JSON.stringify([token, otherToken]);
                        this._cache[keyWithOtherToken] = {
                            pools: poolsForToken[otherToken],
                            timestamp,
                        };
                    });
                }),
            );
        }
        return this._cache[key].pools;
    }

    // tslint:disable-next-line:prefer-function-over-method
    protected async _fetchPoolsForTokenRawAsync(token: string): Promise<BalancerPoolsResponse> {
        // GraphQL is case-sensitive
        // Always use checksum addresses
        const checksumToken = getAddress(token);

        const query = `
      query ($tokens: [Bytes!]) {
          pools (first: 1000, where: {tokensList_contains: $tokens, publicSwap: true, liquidity_gt: 0}, orderBy: swapsCount, orderDirection: desc) {
            id
            publicSwap
            swapFee
            totalWeight
            tokensList
            tokens {
              id
              address
              balance
              decimals
              symbol
              denormWeight
            }
          }
        }
    `;

        const variables = {
            tokens: [checksumToken],
        };

        const response = await fetch(SUBGRAPH_URL, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query,
                variables,
            }),
        });

        const { data } = await response.json();
        return data;
    }
    /**
     *  Loads all pools including the provided token
     */
    // tslint:disable-next-line:typedef
    protected async _fetchPoolsForTokenAsync(token: string) {
        const result = await this._fetchPoolsForTokenRawAsync(token);
        const poolsByOtherToken: { [otherToken: string]: BalancerPool[] } = {};
        result.pools.map(p => {
            const otherTokens = p.tokens.map(t => t.address.toLowerCase()).filter(t => t !== token);
            otherTokens.forEach(otherToken => {
                const poolDatas = parsePoolData([p], token, otherToken);
                if (!poolsByOtherToken[otherToken]) {
                    poolsByOtherToken[otherToken] = [];
                }
                poolsByOtherToken[otherToken] = [...poolsByOtherToken[otherToken], ...poolDatas]
                    .sort((a, b) => b.balanceOut.minus(a.balanceOut).toNumber())
                    .slice(0, this.maxPoolsFetched);
            });
        });
        return poolsByOtherToken;
    }
    // tslint:disable-next-line:prefer-function-over-method
    protected async _fetchPoolsForPairAsync(takerToken: string, makerToken: string): Promise<BalancerPool[]> {
        try {
            const poolData = (await getPoolsWithTokens(takerToken, makerToken)).pools;
            // Sort by maker token balance (descending)
            const pools = parsePoolData(poolData, takerToken, makerToken).sort((a, b) =>
                b.balanceOut.minus(a.balanceOut).toNumber(),
            );
            return pools.length > this.maxPoolsFetched ? pools.slice(0, this.maxPoolsFetched) : pools;
        } catch (err) {
            return [];
        }
    }
}

// tslint:disable completed-docs
export function computeBalancerSellQuote(pool: BalancerPool, takerFillAmount: BigNumber): BigNumber {
    if (takerFillAmount.isGreaterThan(bmath.bmul(pool.balanceIn, bmath.MAX_IN_RATIO))) {
        return ZERO_AMOUNT;
    }
    const weightRatio = pool.weightIn.dividedBy(pool.weightOut);
    const adjustedIn = bmath.BONE.minus(pool.swapFee)
        .dividedBy(bmath.BONE)
        .times(takerFillAmount);
    const y = pool.balanceIn.dividedBy(pool.balanceIn.plus(adjustedIn));
    const foo = Math.pow(y.toNumber(), weightRatio.toNumber());
    const bar = new BigNumber(1).minus(foo);
    const tokenAmountOut = pool.balanceOut.times(bar);
    return tokenAmountOut.integerValue();
}

export function computeBalancerBuyQuote(pool: BalancerPool, makerFillAmount: BigNumber): BigNumber {
    if (makerFillAmount.isGreaterThan(bmath.bmul(pool.balanceOut, bmath.MAX_OUT_RATIO))) {
        return ZERO_AMOUNT;
    }
    const weightRatio = pool.weightOut.dividedBy(pool.weightIn);
    const diff = pool.balanceOut.minus(makerFillAmount);
    const y = pool.balanceOut.dividedBy(diff);
    let foo: number | Decimal = Math.pow(y.toNumber(), weightRatio.toNumber()) - 1;
    if (!Number.isFinite(foo)) {
        foo = new Decimal20(y.toString()).pow(weightRatio.toString()).minus(1);
    }
    let tokenAmountIn = bmath.BONE.minus(pool.swapFee).dividedBy(bmath.BONE);
    tokenAmountIn = pool.balanceIn.times(foo.toString()).dividedBy(tokenAmountIn);
    return tokenAmountIn.integerValue();
}
