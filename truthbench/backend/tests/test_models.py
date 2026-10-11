"""Model-layer tests: constraints, relationships, JSON columns, soft delete."""

import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from app.db.base import utcnow
from app.models import (
    Dataset,
    DatasetExample,
    DatasetVersion,
    EvaluationJob,
    ModelProvider,
    ModelRegistryEntry,
    Organization,
    User,
)


def _make_org_user(db):
    org = Organization(name="Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    db.add(org)
    db.flush()
    user = User(
        organization_id=org.id,
        email=f"user-{uuid.uuid4().hex[:8]}@example.com",
        display_name="Tester",
        password_hash="scrypt$1$1$1$AAAA$BBBB",
        role="researcher",
    )
    db.add(user)
    db.commit()
    return org, user


def test_user_role_check_constraint_rejects_invalid_role(db):
    org, _ = _make_org_user(db)
    db.add(
        User(
            organization_id=org.id,
            email="bad-role@example.com",
            display_name="Bad",
            password_hash="x",
            role="superadmin",
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_dataset_chain_with_examples_and_unique_natural_key(db):
    org, user = _make_org_user(db)
    dataset = Dataset(organization_id=org.id, name="pilot", created_by=user.id)
    db.add(dataset)
    db.flush()
    version = DatasetVersion(dataset_id=dataset.id, version="1.0.0", checksum="a" * 64)
    db.add(version)
    db.flush()
    example = DatasetExample(
        dataset_version_id=version.id,
        example_id="ex-001",
        split="train",
        task_type="factual_qa",
        question="What is the capital of France?",
        context="Paris is the capital of France.",
        reference_answer="Paris",
        label="supported",
        review_status="machine_generated",
        content_hash="b" * 64,
    )
    db.add(example)
    db.commit()

    # Duplicate natural key (same version + example_id) must be rejected.
    db.add(
        DatasetExample(
            dataset_version_id=version.id,
            example_id="ex-001",
            split="test",
            task_type="factual_qa",
            question="duplicate",
            content_hash="c" * 64,
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_registry_unique_identity_per_org_and_nullable_params(db):
    org, user = _make_org_user(db)
    provider = ModelProvider(
        organization_id=org.id, name="Mock", provider_type="mock", credentials_env_var=None
    )
    db.add(provider)
    db.flush()
    entry = ModelRegistryEntry(
        organization_id=org.id,
        provider_id=provider.id,
        model_identifier="mock-deterministic-v1",
        created_by=user.id,
    )
    db.add(entry)
    db.commit()

    # Parameter count must stay NULL when unknown — never inferred.
    assert entry.parameter_count is None
    assert entry.parameter_count_source is None
    assert entry.health_status == "unknown"
    assert entry.hosting == "unknown"
    assert entry.size_category is None

    # Same (org, provider, identifier) twice is a conflict.
    db.add(
        ModelRegistryEntry(
            organization_id=org.id,
            provider_id=provider.id,
            model_identifier="mock-deterministic-v1",
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_evaluation_job_defaults_and_json_columns(db):
    org, user = _make_org_user(db)
    job = EvaluationJob(
        organization_id=org.id,
        created_by=user.id,
        dataset_version_id=uuid.uuid4(),  # FK checked at commit; use a real one below
    )
    # Use a real dataset version to satisfy the FK.
    dataset = Dataset(organization_id=org.id, name="d2")
    db.add(dataset)
    db.flush()
    version = DatasetVersion(dataset_id=dataset.id, version="1.0.0", checksum="d" * 64)
    db.add(version)
    db.flush()
    job.dataset_version_id = version.id
    job.model_ids = [str(uuid.uuid4())]
    job.config = {"judge_enabled": False, "max_examples": 10}
    db.add(job)
    db.commit()

    assert job.status == "pending"
    assert job.progress == {}
    assert job.config["max_examples"] == 10
    assert job.created_at is not None
    assert job.created_at.tzinfo is not None  # UTC-aware timestamps


def test_soft_delete_fields_present(db):
    org, _ = _make_org_user(db)
    user = db.query(User).filter_by(organization_id=org.id).one()
    assert user.deleted_at is None
    user.deleted_at = utcnow()
    db.commit()
    assert user.deleted_at is not None
