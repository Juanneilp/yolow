> start
> node --env-file=.env --experimental-strip-types src/main.ts

file:///D:/Development/yolow/src/main.ts:28
      throw new Error(`top_trending.${field} must be a non-negative number`);
            ^

Error: top_trending.max_token_age_days must be a non-negative number
    at validateConfig (file:///D:/Development/yolow/src/main.ts:28:13)
    at file:///D:/Development/yolow/src/main.ts:48:21

Node.js v22.21.0

errors saat npm start