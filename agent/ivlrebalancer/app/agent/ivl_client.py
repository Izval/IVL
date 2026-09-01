"""Cliente del motor IVL (``api.zvlint.com``) — API pública, sin secreto.

Es el "seam" del agente con IVL (CLAUDE.md §3: no reimplementar el motor, consumir
su API). `/v1/ivl/ticks` devuelve el rango LP v3 (``tickLower/tickUpper``) YA calculado
para PancakeSwap — el núcleo del rebalanceo. Espeja las formas del cliente TypeScript
del marketplace (``app/app/lib/ivl.ts``); verificado contra la API en vivo 18-ago-2026.

⚠ Orientación de ticks (CRÍTICO): IVL cotiza el par como **base-quote** (BNB-USDT ⇒
precio = USDT por BNB ≈ 600 ⇒ ticks POSITIVOS ~+63970). El pool on-chain de Pancake
ordena token0<token1 por address; en BSC testnet ``USDT(0x3376…) < WBNB(0xae13…)`` ⇒
``token0=USDT`` ⇒ sus ticks van NEGADOS e invertidos (~-64110/-63970). La reconciliación
vive en ``pancake_v3.py`` (lee el pool y reorienta). Este módulo solo transporta lo que
IVL devuelve, tal cual.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_IVL_BASE = "https://api.zvlint.com"
DEFAULT_TIMEOUT = 20.0


class IvlApiError(RuntimeError):
    """Fallo al hablar con el motor IVL (HTTP != 2xx o payload inesperado)."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class IvlTicks:
    """Ticks concretos para mintear una posición v3 (convención base-quote de IVL)."""

    tick_lower: int
    tick_upper: int
    tick_spacing: int
    fee_tier: float  # fracción, p.ej. 0.0005 = 0.05%
    price_lower: float
    price_upper: float

    @property
    def fee_units(self) -> int:
        """Fee en unidades Pancake (uint24): 0.0005 → 500."""
        return round(self.fee_tier * 1_000_000)

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "IvlTicks":
        return cls(
            tick_lower=int(d["tickLower"]),
            tick_upper=int(d["tickUpper"]),
            tick_spacing=int(d["tickSpacing"]),
            fee_tier=float(d["feeTier"]),
            price_lower=float(d["priceLower"]),
            price_upper=float(d["priceUpper"]),
        )


@dataclass(frozen=True)
class IvlDecision:
    """La decisión de gestión del rango que produce IVL."""

    action: str  # open_or_hold | withdraw_or_widen | reset
    rationale: str
    breakout_risk: str

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "IvlDecision":
        return cls(
            action=str(d.get("action", "")),
            rationale=str(d.get("rationale", "")),
            breakout_risk=str(d.get("breakoutRisk", "")),
        )


@dataclass(frozen=True)
class IvlTicksResponse:
    """Respuesta de ``GET /v1/ivl/ticks?pair=…`` — el rango ejecutable."""

    pair: str
    ivl_score: float
    classification: str
    decision: IvlDecision
    ticks: IvlTicks
    raw: dict[str, Any]

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "IvlTicksResponse":
        return cls(
            pair=str(d["pair"]),
            ivl_score=float(d.get("ivl_score", 0)),
            classification=str(d.get("classification", "")),
            decision=IvlDecision.from_json(d.get("decision", {}) or {}),
            ticks=IvlTicks.from_json(d["ticks"]),
            raw=d,
        )


def fetch_ticks(
    pair: str,
    *,
    base_url: str = DEFAULT_IVL_BASE,
    timeout: float = DEFAULT_TIMEOUT,
) -> IvlTicksResponse:
    """Lee el rango LP v3 ejecutable de IVL para ``pair`` (p.ej. ``"BNB-USDT"``).

    Lectura pura (sin secreto). Lanza :class:`IvlApiError` si la API falla o el
    payload no trae ``ticks``.
    """
    url = f"{base_url.rstrip('/')}/v1/ivl/ticks"
    try:
        resp = httpx.get(
            url, params={"pair": pair}, timeout=timeout, headers={"accept": "application/json"}
        )
    except httpx.HTTPError as exc:  # DNS, timeout, conexión…
        raise IvlApiError(f"IVL request failed: {exc}") from exc
    if resp.status_code != 200:
        raise IvlApiError(f"IVL {resp.status_code} for {url}?pair={pair}", resp.status_code)
    try:
        data = resp.json()
    except ValueError as exc:
        raise IvlApiError("IVL returned non-JSON body") from exc
    if not isinstance(data, dict) or "ticks" not in data:
        raise IvlApiError("IVL payload missing 'ticks'")
    return IvlTicksResponse.from_json(data)
