import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

export const auth = betterAuth({
  baseURL: "https://watt.invalid",
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "schema-generation",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "schema-generation",
    },
  },
  plugins: [
    jwt(),
    oauthProvider({
      loginPage: "/auth/login",
      consentPage: "/auth/consent",
      allowDynamicClientRegistration: false,
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 2_592_000,
      scopes: ["openid", "profile", "email", "offline_access"],
      resources: [
        {
          identifier: "https://watt.invalid/v1",
          name: "Watt cloud API",
          allowedScopes: ["openid", "profile", "email", "offline_access"],
        },
      ],
    }),
  ],
});
