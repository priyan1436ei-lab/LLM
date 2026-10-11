"""Datasets, versions, examples, source documents.

The dataset_example fields mirror the TruthBench dataset specification exactly
(see DATA_DICTIONARY.md at the repository root).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKey, utcnow

TASK_TYPES = (
    "factual_qa",
    "rag_qa",
    "citation_verification",
    "claim_verification",
    "abstention",
    "multi_document",
)
LABELS = ("supported", "unsupported", "contradicted", "insufficient_evidence")
SPLITS = ("train", "dev", "test")
REVIEW_STATUSES = ("unreviewed", "machine_generated", "human_verified", "human_rejected")


class Dataset(UUIDPrimaryKey, TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "datasets"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), index=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    license: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    versions: Mapped[list["DatasetVersion"]] = relationship(
        back_populates="dataset", cascade="all, delete-orphan"
    )


class DatasetVersion(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "dataset_versions"
    __table_args__ = (UniqueConstraint("dataset_id", "version", name="uq_dataset_version"),)

    dataset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("datasets.id", ondelete="CASCADE"), index=True, nullable=False
    )
    version: Mapped[str] = mapped_column(String(20), nullable=False)
    split_seed: Mapped[int] = mapped_column(default=42, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    counts: Mapped[dict] = mapped_column(default=dict, nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    dataset: Mapped[Dataset] = relationship(back_populates="versions")
    examples: Mapped[list["DatasetExample"]] = relationship(
        back_populates="dataset_version", cascade="all, delete-orphan"
    )


class DatasetExample(UUIDPrimaryKey, Base):
    __tablename__ = "dataset_examples"
    __table_args__ = (
        UniqueConstraint("dataset_version_id", "example_id", name="uq_example_natural_key"),
        CheckConstraint(
            "task_type IN ('factual_qa', 'rag_qa', 'citation_verification', "
            "'claim_verification', 'abstention', 'multi_document')",
            name="ck_examples_task_type",
        ),
        CheckConstraint(
            "label IN ('supported', 'unsupported', 'contradicted', 'insufficient_evidence') "
            "OR label IS NULL",
            name="ck_examples_label",
        ),
        CheckConstraint("split IN ('train', 'dev', 'test')", name="ck_examples_split"),
        CheckConstraint(
            "review_status IN ('unreviewed', 'machine_generated', 'human_verified', "
            "'human_rejected')",
            name="ck_examples_review_status",
        ),
        Index("ix_examples_version_split", "dataset_version_id", "split"),
    )

    dataset_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("dataset_versions.id", ondelete="CASCADE"), nullable=False
    )
    example_id: Mapped[str] = mapped_column(String(100), nullable=False)
    split: Mapped[str] = mapped_column(String(10), nullable=False)
    task_type: Mapped[str] = mapped_column(String(40), nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[str | None] = mapped_column(Text, nullable=True)
    reference_answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Optional pre-existing model answer, for datasets that ship one.
    model_answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str | None] = mapped_column(String(30), nullable=True)
    citation: Mapped[str | None] = mapped_column(String(500), nullable=True)
    citation_supported: Mapped[bool | None] = mapped_column(nullable=True)
    error_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    difficulty: Mapped[str | None] = mapped_column(String(20), nullable=True)
    language: Mapped[str] = mapped_column(String(10), default="en", nullable=False)
    source_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    source_license: Mapped[str | None] = mapped_column(String(100), nullable=True)
    provenance: Mapped[str | None] = mapped_column(String(500), nullable=True)
    generation_method: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reviewer_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    review_status: Mapped[str] = mapped_column(String(30), default="unreviewed", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    # SHA-256 over canonicalised content fields — exact-duplicate detection.
    content_hash: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    dataset_version: Mapped[DatasetVersion] = relationship(back_populates="examples")


class SourceDocument(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "source_documents"
    __table_args__ = (
        UniqueConstraint("dataset_id", "source_id", name="uq_source_document_natural_key"),
    )

    dataset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("datasets.id", ondelete="CASCADE"), index=True, nullable=False
    )
    source_id: Mapped[str] = mapped_column(String(200), nullable=False)
    title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    uri: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    license: Mapped[str | None] = mapped_column(String(100), nullable=True)
    retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
