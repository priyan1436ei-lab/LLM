"""Model providers and the model registry.

Registry rules (from the project brief):
- Parameter counts are NEVER inferred from model names; unknown values stay NULL
  and the source of a verified value is preserved in parameter_count_source.
- Size categories (small/medium/large/very_large) are configurable labels, not
  industry standards.
- cost_metadata and latency fields hold only measured/verified values.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKey

PROVIDER_TYPES = ("openai", "anthropic", "gemini", "huggingface", "ollama", "custom", "mock")
ARCHITECTURES = ("dense", "moe")
HOSTING_MODES = ("api", "local", "unknown")
SIZE_CATEGORIES = ("small", "medium", "large", "very_large")
HEALTH_STATUSES = ("unknown", "healthy", "degraded", "unavailable")


class ModelProvider(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "model_providers"
    __table_args__ = (
        CheckConstraint(
            "provider_type IN ('openai', 'anthropic', 'gemini', 'huggingface', 'ollama', "
            "'custom', 'mock')",
            name="ck_model_providers_type",
        ),
    )

    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    provider_type: Mapped[str] = mapped_column(String(20), nullable=False)
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    # NAME of the environment variable holding the credential — never the value.
    credentials_env_var: Mapped[str | None] = mapped_column(String(100), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class ModelRegistryEntry(UUIDPrimaryKey, TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "model_registry"
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "provider_id", "model_identifier", name="uq_model_registry_identity"
        ),
        CheckConstraint("architecture IN ('dense', 'moe')", name="ck_model_registry_arch"),
        CheckConstraint("hosting IN ('api', 'local', 'unknown')", name="ck_model_registry_hosting"),
        CheckConstraint(
            "size_category IN ('small', 'medium', 'large', 'very_large')",
            name="ck_model_registry_size",
        ),
        CheckConstraint(
            "health_status IN ('unknown', 'healthy', 'degraded', 'unavailable')",
            name="ck_model_registry_health",
        ),
    )

    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    provider_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("model_providers.id", ondelete="CASCADE"), index=True, nullable=False
    )
    model_identifier: Mapped[str] = mapped_column(String(200), index=True, nullable=False)
    family: Mapped[str | None] = mapped_column(String(100), nullable=True)
    architecture: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Unknown parameter counts stay NULL — never inferred from the model name.
    parameter_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parameter_count_source: Mapped[str | None] = mapped_column(String(300), nullable=True)
    active_parameter_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    context_window_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    input_modalities: Mapped[list] = mapped_column(default=list, nullable=False)
    output_modalities: Mapped[list] = mapped_column(default=list, nullable=False)
    quantization: Mapped[str | None] = mapped_column(String(50), nullable=True)
    hosting: Mapped[str] = mapped_column(String(20), default="unknown", nullable=False)
    api_available: Mapped[bool | None] = mapped_column(nullable=True)
    model_revision: Mapped[str | None] = mapped_column(String(100), nullable=True)
    evaluation_config: Mapped[dict] = mapped_column(default=dict, nullable=False)
    cost_metadata: Mapped[dict | None] = mapped_column(nullable=True)
    size_category: Mapped[str | None] = mapped_column(String(20), nullable=True)
    health_status: Mapped[str] = mapped_column(String(20), default="unknown", nullable=False)
    last_health_check_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    latency_ms_p50: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms_p95: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
