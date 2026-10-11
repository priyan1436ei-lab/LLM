"""Evaluation jobs, runs, examples, model outputs, citations, metrics.

Raw model outputs are stored separately from evaluation labels — the two are
never conflated (brief §9 point 5).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKey, utcnow

JOB_STATUSES = ("pending", "running", "completed", "failed", "cancelled", "partial")


class EvaluationJob(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "evaluation_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'partial')",
            name="ck_evaluation_jobs_status",
        ),
    )

    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    dataset_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("dataset_versions.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    model_ids: Mapped[list] = mapped_column(nullable=False)  # registry entry ids (str)
    config: Mapped[dict] = mapped_column(default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True, nullable=False)
    progress: Mapped[dict] = mapped_column(default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    runs: Mapped[list["EvaluationRun"]] = relationship(
        back_populates="job", cascade="all, delete-orphan"
    )


class EvaluationRun(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "evaluation_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed', 'cancelled')",
            name="ck_evaluation_runs_status",
        ),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("evaluation_jobs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    model_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("model_registry.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True, nullable=False)
    config_snapshot: Mapped[dict] = mapped_column(default=dict, nullable=False)
    counts: Mapped[dict] = mapped_column(default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    job: Mapped[EvaluationJob] = relationship(back_populates="runs")


class ModelOutput(UUIDPrimaryKey, Base):
    """Raw provider output, kept separate from evaluation labels."""

    __tablename__ = "model_outputs"
    __table_args__ = (
        UniqueConstraint("run_id", "dataset_example_id", name="uq_model_output_per_example"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("evaluation_runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    dataset_example_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("dataset_examples.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    finish_reason: Mapped[str | None] = mapped_column(String(50), nullable=True)
    usage: Mapped[dict | None] = mapped_column(nullable=True)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    model_reported: Mapped[str | None] = mapped_column(String(200), nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class EvaluationExample(UUIDPrimaryKey, Base):
    """Evaluation of one model output against one dataset example."""

    __tablename__ = "evaluation_examples"
    __table_args__ = (
        UniqueConstraint("run_id", "dataset_example_id", name="uq_eval_example_per_run"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("evaluation_runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    dataset_example_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("dataset_examples.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    prompt_used: Mapped[str] = mapped_column(Text, nullable=False)
    model_output_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("model_outputs.id", ondelete="SET NULL"), nullable=True
    )
    grounding_results: Mapped[dict | None] = mapped_column(nullable=True)
    citation_results: Mapped[dict | None] = mapped_column(nullable=True)
    correctness: Mapped[dict | None] = mapped_column(nullable=True)
    abstention: Mapped[dict | None] = mapped_column(nullable=True)
    rag_results: Mapped[dict | None] = mapped_column(nullable=True)
    # LLM-as-judge output (includes evaluator model and prompt version).
    # Explicitly flagged as a judgment, never treated as ground truth.
    judge_result: Mapped[dict | None] = mapped_column(nullable=True)
    predicted_label: Mapped[str | None] = mapped_column(String(30), nullable=True)
    reference_label: Mapped[str | None] = mapped_column(String(30), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens: Mapped[dict | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class CitationRecord(UUIDPrimaryKey, Base):
    __tablename__ = "citations"
    __table_args__ = (
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_citations_confidence",
        ),
    )

    evaluation_example_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("evaluation_examples.id", ondelete="CASCADE"), index=True, nullable=False
    )
    cited_source: Mapped[str] = mapped_column(String(500), nullable=False)
    matched_source_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    exists_in_sources: Mapped[bool | None] = mapped_column(nullable=True)
    relevant: Mapped[bool | None] = mapped_column(nullable=True)
    supporting: Mapped[bool | None] = mapped_column(nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    method: Mapped[str] = mapped_column(String(50), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class EvaluationMetric(UUIDPrimaryKey, Base):
    __tablename__ = "evaluation_metrics"
    __table_args__ = (UniqueConstraint("run_id", "metric_key", name="uq_metric_per_run"),)

    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("evaluation_runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    metric_key: Mapped[str] = mapped_column(String(60), nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    numerator: Mapped[float | None] = mapped_column(Float, nullable=True)
    denominator: Mapped[float | None] = mapped_column(Float, nullable=True)
    details: Mapped[dict | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
