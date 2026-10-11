"""Pagination primitives shared by all list endpoints."""

from dataclasses import dataclass
from typing import Any

from fastapi import Query
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session


@dataclass
class PageParams:
    page: int = 1
    size: int = 20

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.size


def page_params(
    page: int = Query(1, ge=1, description="1-based page number"),
    size: int = Query(20, ge=1, le=100, description="Items per page (max 100)"),
) -> PageParams:
    """FastAPI dependency for paginated endpoints."""
    return PageParams(page=page, size=size)


def paginate(db: Session, stmt: Select, params: PageParams) -> tuple[list[Any], int]:
    """Execute a statement with pagination; returns (rows, total_count)."""
    count_stmt = select(func.count()).select_from(stmt.order_by(None).subquery())
    total = db.execute(count_stmt).scalar_one()
    rows = db.execute(stmt.offset(params.offset).limit(params.size)).scalars().all()
    return list(rows), total
