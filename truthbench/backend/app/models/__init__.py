"""All ORM models. Importing this package registers every table on Base.metadata,
which is what Alembic and the test fixtures rely on."""

from app.models.dataset import (
    Dataset,
    DatasetExample,
    DatasetVersion,
    SourceDocument,
)
from app.models.evaluation import (
    CitationRecord,
    EvaluationExample,
    EvaluationJob,
    EvaluationMetric,
    EvaluationRun,
    ModelOutput,
)
from app.models.misc import ApiKeyMetadata, AuditEvent, Report
from app.models.organization import Organization, Project, User
from app.models.provider import ModelProvider, ModelRegistryEntry

__all__ = [
    "ApiKeyMetadata",
    "AuditEvent",
    "CitationRecord",
    "Dataset",
    "DatasetExample",
    "DatasetVersion",
    "EvaluationExample",
    "EvaluationJob",
    "EvaluationMetric",
    "EvaluationRun",
    "ModelOutput",
    "ModelProvider",
    "ModelRegistryEntry",
    "Organization",
    "Project",
    "Report",
    "SourceDocument",
    "User",
]
