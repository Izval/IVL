# agent-ivl — IVL Rebalancer (BNBAgent SDK)

Agente ERC-8004 que lee el rango LP en vivo del motor IVL (`api.zvlint.com/v1/ivl/ticks`)
y **abre / mantiene / resetea** una posición PancakeSwap **v3** en BSC testnet. Es el flagship
del marketplace y cubre el bounty PancakeSwap. Ver [`../docs/roadmap.md`](../docs/roadmap.md) §4b.

## Layout

```
agent-ivl/
├── .venv/                     # venv del CLI `bag` (Python 3.12) — gitignored
├── requirements*.txt          # deps del CLI bag
└── ivlrebalancer/             # ⬅ PROYECTO DEL AGENTE (scaffold `bag init`, workspace SDK)
    ├── studio.toml            # config del workspace
    ├── .studio/               # keystore + .env.local (SECRETOS) — gitignored
    └── app/agent/             # el Agente (único firmante, capa de valor)
        ├── main.py            # entrypoint A2A (instrucción = IVL Rebalancer)
        ├── seller_core.py     # lógica seller ERC-8183 (negotiate / notify_funded)
        ├── signing.py         # TODA la firma (código fijo, nunca un tool LLM)
        ├── tools.py           # tools READ-ONLY del LLM (incl. ivl_rebalance_plan)
        ├── ivl_client.py      # ⬅ cliente del motor IVL (httpx)
        ├── pancake_v3.py      # ⬅ ejecución LP v3 (mint + orientación de ticks)
        ├── rebalance.py       # ⬅ orquestador: IVL → decisión → dry-run/execute + CLI
        └── .venv/             # venv del agente (google-adk, web3…) — gitignored
```

Los tres módulos `⬅` son el trabajo de la **Fase 1** (rebalanceo IVL→LP v3).

## Qué hace el agente

1. **Lee IVL** (`ivl_client.py`): `GET /v1/ivl/ticks?pair=BNB-USDT` → `tickLower/tickUpper`,
   `tickSpacing`, `feeTier` y `decision.action` (`open_or_hold` / `withdraw_or_widen` / `reset`).
2. **Ejecuta LP v3** (`pancake_v3.py`): encodea `NonfungiblePositionManager.mint(MintParams{…})`
   con esos ticks y lo firma con el `EVMWalletProvider` del SDK (el agente = único firmante).
3. **Orquesta** (`rebalance.py`): mapea la acción IVL a una intención (mint / rewiden / reset),
   hace **dry-run** (`eth_call`, sin gastar) o ejecuta, y produce el manifiesto que entrega el seller.
4. La skill de solo-lectura `ivl_rebalance_plan` está registrada como tool del LLM en `tools.py`;
   la **firma/broadcast** (`rebalance.execute_rebalance`) es **código fijo, nunca un tool** — igual
   que `signing.py`: el dinero jamás pasa por el LLM.

> **Sin LLM por defecto (decisión 18-ago-2026):** el deliverable del seller es DETERMINISTA (el
> plan + la tx), no prosa. El hook `run_work` (`main._run_rebalance`) llama a `plan_rebalance` y
> devuelve el manifiesto — **no invoca ningún LLM**. Por eso `bag dev` **no requiere
> `ANTHROPIC_API_KEY`** ni gasta tokens/$U. `build_model()` quedó **perezoso** (`_get_runner`): el
> LLM sigue disponible como opción (explicación en lenguaje natural) pero apagado por defecto.

## Verificación local (hecha, sin gastar tBNB)

Dry-run del mint contra el pool real de BSC testnet:

```bash
cd ivlrebalancer/app/agent
./.venv/bin/python rebalance.py --pair BNB-USDT          # resumen legible
./.venv/bin/python rebalance.py --pair BNB-USDT --json   # reporte completo
```

Resultado verificado (18-ago-2026):
- IVL en vivo: score 57, acción `withdraw_or_widen`.
- Pool `WBNB/USDT fee=500` (`0x2dbB5a4c…`) encontrado; `tickSpacing=10`.
- **Orientación reconciliada**: IVL da ticks `+63970/+64110` (BNB en USDT); como `USDT < WBNB`
  por address, el pool tiene `token0=USDT` ⇒ ticks on-chain `[-64110, -63970]` (`inverted=True`).
- `eth_call` revierte con `STF` (sin balance) → **el contrato decodificó el calldata** ⇒
  `encoding_valid=True`. Round-trip de decodificación del mint: OK.

> ⚠ **Nota de testnet:** el pool de testnet está **mal-preciado** (tick actual ~-24124 ⇒ ~11 USDT/BNB)
> vs el precio real de IVL (~600). Por eso `in_range=False` en testnet: el rango real de IVL no
> solapa el tick sintético del pool de testnet. El **mecanismo** (encoding+orientación+mint) queda
> probado; la **evidencia de fees** (bounty PancakeSwap) sale del backtest sobre datos reales
> (Fase 3, `third_city/skills/ivl/scripts`), no del pool de juguete de testnet.

Direcciones BSC testnet (chainId 97) verificadas en vivo — en `pancake_v3.RebalancerConfig`:
`V3Factory 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` · `NPM 0x427bF5b37357632377eCbEC9de3626C71A5396c1`
· `WBNB 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd` · `USDT 0x337610d27c682E347C9cD60BD4b3b107C9d34dDd`.

`bag doctor`: `network reachable` PASS, `framework runtime importable (adk)` PASS. Los WARN
restantes son exactamente los pasos de credenciales de abajo.

## ⛔ Handoff — pasos bloqueados por credenciales (los haces tú)

Todo lo anterior corre en local sin gastar nada. Para la tx onchain (requisito duro del hackathon)
falta **importar la clave** de tu wallet (el agente firma con ella) y sacar la API key 8004scan Pro.
**Sin `ANTHROPIC_API_KEY`** — el seller es determinista (ver nota arriba).

Wallet en uso: **`0xf63474d85aa7ea5f7d7969468723a0e635064c1e`** (ya fondeada). Desde `agent-ivl/` con el
venv del CLI activo (`source .venv/bin/activate`), dentro de `ivlrebalancer/`:

1. **Importar tu clave** (nunca se pega inline ni se comparte; prompt oculto):
   ```bash
   export WALLET_PASSWORD='<elige-uno-fuerte>'          # bag lo lee del shell; no se escribe a disco
   (cd app/agent && bag wallet new --private-key)       # prompt oculto → pega la clave localmente
   (cd app/agent && bag wallet show)                    # debe imprimir 0xf634…4c1e
   ```
   Luego fijar `address = "0xf63474d85aa7ea5f7d7969468723a0e635064c1e"` en `studio.toml [wallet]`
   (ancla anti-drift). Faucet **no hace falta** (ya tiene fondos; verifica con `bag wallet balance`).
   > ⚠ La wallet ya fondeada sirve para **local + `erc8004 register`** (la clave se queda en tu máquina).
   > Para el **`bag deploy` gestionado**, el SDK **transmite la clave** al operador → usa una **throwaway**.
2. **API key 8004scan Pro** (form: https://forms.gle/jQevEPCAacBXaKG79) → `.studio/.env.local`
   (gitignored). *Opcional:* el proxy funciona anónimo; la key solo sube el rate-limit.
3. **Identidad onchain (primera tx, requisito duro):**
   ```bash
   (cd app/agent && bag erc8004 register)               # aparece en 8004scan
   ```
4. **Correr el agente en local** (necesita 1; **no** necesita key de LLM):
   ```bash
   (cd app/agent && ./.venv/bin/bag dev)                # usa el venv del agente para que las deps casen
   ```
5. **Ejecutar el rebalanceo real** (con wallet fondeada): `rebalance.execute_rebalance` ya está
   **implementado** (approve→mint; y decrease+collect[+burn]→mint para rewiden/reset). Gated: firma con
   `get_wallet()` y exige saldo. Dispara por CLI:
   ```bash
   # El mint v3 gasta WBNB/USDT (ERC20), NO tBNB nativo. Primero envuelve tBNB→WBNB
   # (deposit() en el contrato WBNB 0xae13…a7cd) y consigue algo de USDT testnet.
   (cd app/agent && ./.venv/bin/python rebalance.py --pair BNB-USDT --execute --cap-base 0.02)
   # → { steps:{approvals,mint_tx}, token_id, explorer: testnet.bscscan.com/tx/… }
   ```
   > ⚠ El pool de testnet está mal-preciado (ver nota arriba): la posición saldrá **single-sided /
   > out-of-range**. El **mecanismo** (approve+mint+orientación) queda probado onchain con un tx real
   > verificable; la **evidencia de fees** (bounty PancakeSwap) sale del `reports/` sobre datos reales.
6. **Deploy gestionado — AL FINAL, cerca del judging:** `bag deploy prepare` → `bag platform login`
   + `bag deploy agent`. ⚠ **Arranca el reloj de 48h del trial** — no lo dispares antes de tener todo listo.
   ⚠ Recuerda: para el deploy gestionado usa una wallet **throwaway** (no la fondeada real).

## Entorno del CLI (ya hecho)

- **Python 3.12** (Homebrew) + venv en `.venv/`. `pip install -r requirements.txt` → `bnbagent-studio 0.0.5`
  (CLI **`bag`**). El agente tiene su **propio** venv en `app/agent/.venv` (google-adk, web3, httpx…),
  creado con `python -m venv app/agent/.venv && app/agent/.venv/bin/pip install -e ./app/agent`.
