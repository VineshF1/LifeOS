"""Application configuration loaded from environment / .env."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Infrastructure -----------------------------------------------------
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/lifeos"
    JWT_SECRET: str = "insecure-dev-secret-change-me"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 60 * 24 * 7

    # --- NVIDIA NIM ---------------------------------------------------------
    NVIDIA_API_KEY: str = ""
    NVIDIA_BASE_URL: str = "https://integrate.api.nvidia.com/v1"
    LLM_MODEL: str = "nvidia/nemotron-3-super-120b-a12b"
    EMBEDDING_MODEL: str = "nvidia/nemotron-3-embed-1b"
    EMBEDDING_DIM: int = 2048

    # 10-15s guardrail from the spec, applied per NIM HTTP call.
    NIM_TIMEOUT_SECONDS: float = 15.0
    # Chat turns carry the whole conversation + tool schemas and generate the
    # final answer: the 120B model needs more headroom than a 15s budget
    # allows under load. Bounded by the agent's 60s total budget + the
    # frontend's 120s chat timeout.
    CHAT_TIMEOUT_SECONDS: float = 30.0
    # One explicit retry on timeout for chat turns: NIM slowness is usually
    # transient (a 3s turn now, a 15s+ stall a minute later).
    CHAT_TIMEOUT_RETRIES: int = 1
    # Hard ceiling for a whole agent turn so a slow upstream can never hang a worker.
    AGENT_TOTAL_BUDGET_SECONDS: float = 60.0

    # --- Agent loop ---------------------------------------------------------
    AGENT_MAX_ITERATIONS: int = 3
    AGENT_MAX_TOKENS: int = 1024
    TOOL_RESULT_CHAR_LIMIT: int = 6000

    # --- Ingestion ----------------------------------------------------------
    CHUNK_TOKENS: int = 400
    CHUNK_OVERLAP_RATIO: float = 0.15
    MIN_EXTRACTABLE_CHARS: int = 50
    EXTRACTION_CHAR_LIMIT: int = 24000
    # Extraction prompts carry up to 24k chars of document text: the 120B
    # model needs more than 15s under load. One retry — NIM stalls are
    # usually transient — then the caller degrades to needs_review.
    EXTRACTION_TIMEOUT_SECONDS: float = 30.0
    EXTRACTION_TIMEOUT_RETRIES: int = 1
    EMBEDDING_BATCH_SIZE: int = 16

    # --- Web ----------------------------------------------------------------
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"

    # --- Phase 2: tiers / billing (Razorpay) -------------------------------
    FREE_DOCUMENT_LIMIT: int = 5
    RAZORPAY_KEY_ID: str = ""
    RAZORPAY_KEY_SECRET: str = ""
    # Phase 3 alias (compose/env convention): fills KEY_SECRET when empty.
    RAZORPAY_SECRET: str = ""
    RAZORPAY_PLAN_ID: str = ""
    RAZORPAY_WEBHOOK_SECRET: str = ""
    FRONTEND_URL: str = "http://localhost:3000"

    # --- Phase 2: multi-doc reasoning ---------------------------------------
    # Scatter-gather fan-out cap; matches the existing iteration-limit pattern
    # and keeps the SSE stream inside the proxy timeout budget.
    SYNTHESIZE_MAX_DOCS: int = 4
    SYNTHESIZE_TOP_K_PER_DOC: int = 3

    # --- Phase 3: async queue / shared storage ------------------------------
    REDIS_URL: str = "redis://localhost:6379/0"
    UPLOAD_DIR: str = "/app/uploads"
    MAX_UPLOAD_MB: int = 25

    # Phase 3 chat model: fast MoE reasoner for interactive Q&A (thinking off).
    # Extraction/metadata stays on LLM_MODEL (120B) unless overridden.
    CHAT_MODEL: str = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    EMBED_MODEL: str = "nvidia/nemotron-3-embed-1b"
    EMBED_DIMENSIONS: int = 2048

    def validate_billing(self) -> None:
        """Fail-loud: half-configured billing must never silently demo-upgrade.

        Matches V2 semantics: the boot gate covers the three gateway keys.
        RAZORPAY_WEBHOOK_SECRET is verified at webhook time, not boot —
        without it checkout still opens; only the post-payment tier flip
        requires the webhook secret to be set.
        """
        secret = self.RAZORPAY_KEY_SECRET or self.RAZORPAY_SECRET
        keys = [self.RAZORPAY_KEY_ID, secret, self.RAZORPAY_PLAN_ID]
        if any(keys) and not all(keys):
            missing = [n for n, v in (
                ("RAZORPAY_KEY_ID", self.RAZORPAY_KEY_ID),
                ("RAZORPAY_KEY_SECRET", secret),
                ("RAZORPAY_PLAN_ID", self.RAZORPAY_PLAN_ID)) if not v]
            raise RuntimeError(f"Billing misconfigured, missing: {', '.join(missing)}")

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def chunk_overlap_tokens(self) -> int:
        return max(1, round(self.CHUNK_TOKENS * self.CHUNK_OVERLAP_RATIO))


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
