from datetime import timedelta
from typing import List, NamedTuple, Optional

import config

from utils import (
    DateUtils,
    get_slot_value,
)


class ValidationProblem(NamedTuple):
    slots_to_clear: List[str]
    slot_to_elicit: str
    message: str


def _check_same_source_destination(
    source,
    destination,
) -> Optional[ValidationProblem]:

    if (
        source
        and destination
        and source.strip().lower() == destination.strip().lower()
    ):
        return ValidationProblem(
            ["destination"],
            "destination",
            config.SAME_SOURCE_DESTINATION,
        )

    return None


def _check_start_not_in_past(
    start,
    start_date,
) -> Optional[ValidationProblem]:

    cutoff = DateUtils.today() - timedelta(days=config.PAST_DATE_GRACE_DAYS)

    if start and start < cutoff:
        return ValidationProblem(
            ["startDate", "endDate"],
            "startDate",
            config.PAST_DATE_MESSAGE.format(
                start_date=DateUtils.format(start),
                example_date=DateUtils.example(),
            ),
        )

    return None


def _check_end_after_start(
    start,
    end,
    start_date,
    end_date,
) -> Optional[ValidationProblem]:

    if start and end and end < start:
        return ValidationProblem(
            ["startDate", "endDate"],
            "startDate",
            config.RETURN_BEFORE_START_MESSAGE.format(
                start_date=DateUtils.format(start),
                end_date=DateUtils.format(end),
                example_date=DateUtils.example(),
            ),
        )

    return None


def validate_filled_slots(
    slots,
) -> Optional[ValidationProblem]:

    source = get_slot_value(slots, "source")
    destination = get_slot_value(slots, "destination")
    start_date = get_slot_value(slots, "startDate")
    end_date = get_slot_value(slots, "endDate")

    start = DateUtils.parse(start_date)
    end = DateUtils.parse(end_date)

    return (
        _check_same_source_destination(source, destination)
        or _check_start_not_in_past(start, start_date)
        or _check_end_after_start(start, end, start_date, end_date)
    )