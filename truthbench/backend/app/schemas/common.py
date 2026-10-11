"""Shared API schemas: pagination envelope."""

from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class PaginationInfo(BaseModel):
    page: int
    size: int
    total: int
    pages: int


class Paginated(BaseModel, Generic[T]):
    items: list[T]
    pagination: PaginationInfo

    @classmethod
    def build(cls, items: list[T], total: int, page: int, size: int) -> "Paginated[T]":
        pages = (total + size - 1) // size if size else 0
        return cls(items=items, pagination=PaginationInfo(page=page, size=size, total=total, pages=pages))
