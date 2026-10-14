/**
 * Wallet stack: wagmi + RainbowKit, Arc mainnet only, injected wallets (MetaMask, Rabby, ...).
 * No WalletConnect project id and no server: the wallet is the only signer.
 */
import { Buffer } from "buffer";
import "@rainbow-me/rainbowkit/styles.css";
import { useState, type ReactNode } from "react";
import { connectorsForWallets, lightTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, http, WagmiProvider } from "wagmi";
import { arc } from "./chain";

const g = globalThis as unknown as { Buffer?: unknown; global?: unknown };
if (typeof g.Buffer === "undefined") g.Buffer = Buffer;
if (typeof g.global === "undefined") g.global = globalThis;

const connectors = connectorsForWallets([{ groupName: "Installed", wallets: [injectedWallet] }], {
  appName: "IVL on Arc",
  projectId: "",
});

export const wagmiConfig = createConfig({
  chains: [arc],
  connectors,
  transports: { [arc.id]: http() },
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          modalSize="compact"
          theme={lightTheme({ accentColor: "#2b2927", accentColorForeground: "#ece9e5", borderRadius: "small", fontStack: "system", overlayBlur: "small" })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
