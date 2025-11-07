/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pump.json`.
 */
export const IDL = {
  "address": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "metadata": {
    "name": "pump",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "buy",
      "discriminator": [102, 6, 61, 18, 1, 218, 235, 234],
      "accounts": [],
      "args": []
    }
  ],
  "accounts": [],
  "events": [
    {
      "name": "tradeEvent",
      "discriminator": [189, 219, 127, 211, 78, 230, 97, 238]
    }
  ],
  "errors": [],
  "types": [
    {
      "name": "tradeEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "solAmount",
            "type": "u64"
          },
          {
            "name": "tokenAmount",
            "type": "u64"
          },
          {
            "name": "isBuy",
            "type": "bool"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "virtualSolReserves",
            "type": "u64"
          },
          {
            "name": "virtualTokenReserves",
            "type": "u64"
          },
          {
            "name": "realSolReserves",
            "type": "u64"
          },
          {
            "name": "realTokenReserves",
            "type": "u64"
          },
          {
            "name": "feeRecipient",
            "type": "pubkey"
          },
          {
            "name": "feeBasisPoints",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "creatorFeeBasisPoints",
            "type": "u64"
          },
          {
            "name": "creatorFee",
            "type": "u64"
          },
          {
            "name": "trackVolume",
            "type": "bool"
          },
          {
            "name": "totalUnclaimedTokens",
            "type": "u64"
          },
          {
            "name": "totalClaimedTokens",
            "type": "u64"
          },
          {
            "name": "currentSolVolume",
            "type": "u64"
          },
          {
            "name": "lastUpdateTimestamp",
            "type": "i64"
          },
          {
            "name": "ixName",
            "type": "string"
          }
        ]
      }
    }
  ]
};

export type Pump = {
  "address": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "metadata": {
    "name": "pump",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  }
};
