const { CosmWasmClient } = require("secretjs");
const BigNumber = require("bignumber.js");
const sdk = require('@defillama/sdk');
const utils = require("./utils");

const factoryContract = "secret1zvk7pvhtme6j8yw3ryv0jdtgg937w0g0ggu8yy";
const pairCodeId = 111;
const factoryContractV2 = "secret18sq0ux28kt2z7dlze2mu57d3ua0u5ayzwp6v2r";
const pairCodeIdV2 = 361;
const SIENNA_SINGLE_SIDED_POOLS = [
    { address: "secret1ja57vrpqusx99rgvxacvej3vhzhh4rhlkdkd7w", version: 1 },
    { address: "secret109g22wm3q3nfys0v6uh7lqg68cn6244n2he4t6", version: 2 },
    { address: "secret1uta9zf3prn7lvc6whp8sqv7ynxmtz3jz9xkyu7", version: 3 }
];
const SIENNA_TOKEN_ADDRESS = "secret1rgm2m5t530tdzyd99775n6vzumxa5luxcllml4";
const LEND_OVERSEER_CONTRACT = null;

const SECRET_NODE_URL = "https://bridgeapi.azure-api.net/proxy/";
const queryClient = new CosmWasmClient(SECRET_NODE_URL);

async function Pairs() {
    return (await PairsV1()).concat(await PairsV2());
}

async function PairsV1() {
    const pairs = await queryClient.getContracts(pairCodeId);
    return pairs.filter((p) => p.label.endsWith(`${factoryContract}-${pairCodeId}`));
}

async function PairsV2() {
    const pairs = await queryClient.getContracts(pairCodeIdV2);
    return pairs.filter((p) => p.label.endsWith(`${factoryContractV2}-${pairCodeIdV2}`));
}

async function TokenInfo(tokenAddress) {
    const result = await queryClient.queryContractSmart(tokenAddress, { token_info: {} });
    return result.token_info;
}

async function PairsVolumes() {
    const volumes = []

    const pairs = await Pairs();

    await Promise.all(pairs.map(async contract => {
        const pair_info = (await queryClient.queryContractSmart(contract.address, "pair_info")).pair_info;

        const token1 = await TokenInfo(pair_info.pair.token_0.custom_token.contract_addr);
        volumes.push({
            tokens: new BigNumber(pair_info.amount_0).div(new BigNumber(10).pow(token1.decimals)).toNumber(),
            symbol: token1.symbol
        });

        const token2 = await TokenInfo(pair_info.pair.token_1.custom_token.contract_addr);
        volumes.push({
            tokens: new BigNumber(pair_info.amount_1).div(new BigNumber(10).pow(token2.decimals)).toNumber(),
            symbol: token2.symbol
        });
    }));
    return volumes;
}

async function getLendMarkets() {
    if (!LEND_OVERSEER_CONTRACT) return [];
    let markets = [], grabMarkets = true, start = 0;

    while (grabMarkets) {
        const result = await queryClient.queryContractSmart(LEND_OVERSEER_CONTRACT, {
            markets: {
                pagination: {
                    limit: 10,
                    start: start
                }
            }
        });
        if (result && result.entries && result.entries.length) {
            markets = markets.concat(result.entries);
            start = markets.length;
        } else grabMarkets = false;
    }

    return markets;
}

async function Lend() {
    const markets = await getLendMarkets();
    const block = await queryClient.getHeight();
    return Promise.all(markets.map(async (market) => {
        const marketState = await queryClient.queryContractSmart(market.contract.address, {
            state: {
                block
            }
        });
        const exchange_rate = await queryClient.queryContractSmart(market.contract.address, {
            exchange_rate: {
                block
            }
        });
        const underlying_asset = await queryClient.queryContractSmart(market.contract.address, { underlying_asset: {} });
        const token = await TokenInfo(underlying_asset.address);
        return {
            symbol: token.symbol,
            tokens_supplied: new BigNumber(marketState.total_supply).times(exchange_rate).div(new BigNumber(10).pow(token.decimals)).toNumber(),
            tokens_borrowed: new BigNumber(marketState.total_borrows).div(new BigNumber(10).pow(token.decimals).toNumber()).toNumber(),
        };
    }));
}

async function StakedTokens() {
    const siennaToken = await TokenInfo(SIENNA_TOKEN_ADDRESS);
    const stakedTokens = await Promise.all(SIENNA_SINGLE_SIDED_POOLS.map(async (pool) => {
        let total_locked;
        if (pool.version === 3) {
            const fetchedPool = await queryClient.queryContractSmart(pool.address, { rewards: { pool_info: { at: new Date().getTime() } } });
            total_locked = fetchedPool.rewards.pool_info.staked;
        } else {
            const fetchedPool = await queryClient.queryContractSmart(pool.address, { pool_info: { at: new Date().getTime() } });
            total_locked = fetchedPool.pool_info.pool_locked;
        }
        return new BigNumber(total_locked).div(new BigNumber(10).pow(siennaToken.decimals)).toNumber();
    }));
    return stakedTokens.reduce((total, value) => total + value, 0);
}

async function TVL() {
    const balances = {};

    const pairs_volumes = await PairsVolumes();
    await Promise.all(pairs_volumes.map(async volume => {
        if (utils.symbolsMap[volume.symbol]) await sdk.util.sumSingleBalance(balances, utils.symbolsMap[volume.symbol], volume.tokens);
    }));

    const staked_tokens = await StakedTokens();
    if (staked_tokens) await sdk.util.sumSingleBalance(balances, "sienna", staked_tokens);

    const lend_data = await Lend();

    await Promise.all(lend_data.map(async volume => {
        if (utils.symbolsMap[volume.symbol]) await sdk.util.sumSingleBalance(balances, utils.symbolsMap[volume.symbol], volume.tokens_supplied);
    }));

    return balances;
}

module.exports = {
    misrepresentedTokens: true,
    timetravel: false,
    methodology: 'All tokens locked in SIENNA Network pairs + All the supplied tokens to Sienna Lend Markets + Staked Sienna;',
    secret: {
        tvl: TVL
    }
};