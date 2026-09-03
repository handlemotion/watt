import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";

import * as authSchema from "./db/auth-schema.js";
import type { CloudDatabase } from "./database.js";

export function createAuth(env: CloudflareBindings, db: CloudDatabase) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: env.AUTH_LOGIN_URL,
        consentPage: env.AUTH_CONSENT_URL,
        allowDynamicClientRegistration: false,
        accessTokenExpiresIn: 900,
        refreshTokenExpiresIn: 2_592_000,
        scopes: ["openid", "profile", "email", "offline_access"],
        cachedTrustedClients: new Set(["watt-desktop"]),
        resources: [
          {
            identifier: `${env.BETTER_AUTH_URL}/v1`,
            name: "Watt cloud API",
            allowedScopes: ["openid", "profile", "email", "offline_access"],
          },
        ],
      }),
    ],
  });
}
