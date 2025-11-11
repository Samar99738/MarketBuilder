export const RAYDIUM_AMM_V4_IDL = {
    "version": "0.1.0",
    "name": "raydium_amm_v4",
    "instructions": [],
    "events": [
        {
            "name": "SwapEvent",
            "fields": [
                {
                    "name": "ammId",
                    "type": "publicKey",
                    "index": false
                },
                {
                    "name": "inputVault",
                    "type": "publicKey",
                    "index": false
                },
                {
                    "name": "outputVault",
                    "type": "publicKey",
                    "index": false
                },
                {
                    "name": "inputAmount",
                    "type": "u64",
                    "index": false
                },
                {
                    "name": "outputAmount",
                    "type": "u64",
                    "index": false
                },
            ]
        }
    ]
} as const;

export type RaydiumAmmV4Idl = typeof RAYDIUM_AMM_V4_IDL;