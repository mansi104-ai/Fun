
import functools
import json
import logging
import traceback
from datetime import datetime, date, timedelta, timezone
from logging.handlers import RotatingFileHandler

import config


def get_logger():
    logger = logging.getLogger(config.LOGGER_NAME)
    if logger.handlers: 
        return logger

    logger.setLevel(getattr(logging, config.LOG_LEVEL, logging.INFO))
    logger.propagate = False
    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    logger.addHandler(stream)

    try:
        file_handler = RotatingFileHandler(
            config.LOG_FILE_PATH,
            maxBytes=config.LOG_MAX_BYTES,
            backupCount=config.LOG_BACKUP_COUNT,
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except OSError as exc:
        logger.warning("File logging disabled: %s", exc)

    return logger


def _to_json(payload):
    try:
        return json.dumps(payload, default=str)
    except (TypeError, ValueError):
        return str(payload)


class DateUtils:

    @staticmethod
    def now():
        tz = timezone(
            timedelta(
                hours=config.UTC_OFFSET_HOURS,
                minutes=config.UTC_OFFSET_MINUTES,
            )
        )
        return datetime.now(tz)

    @classmethod
    def today(cls):
        return cls.now().date()

    @staticmethod
    def parse(value):
        if not value:
            return None
        for fmt in (config.LEX_DATE_FORMAT, config.DISPLAY_DATE_FORMAT):
            try:
                return datetime.strptime(value, fmt).date()
            except ValueError:
                continue
        return None

    @classmethod
    def format(cls, value):
        parsed = value if isinstance(value, date) else cls.parse(value)
        return parsed.strftime(config.DISPLAY_DATE_FORMAT) if parsed else value

    @classmethod
    def example(cls):
        return cls.format(cls.today() + timedelta(days=1))


def get_slot_value(slots, slot_name):
    slot = slots.get(slot_name)
    if not slot:
        return None
    value = slot.get("value")
    if not value:
        return None
    return value.get("interpretedValue")


class LexRequest:

    def __init__(self, event):
        self.event = event
        session_state = event["sessionState"]
        self.intent = session_state["intent"]
        self.slots = self.intent.get("slots") or {}
        self.session_attributes = session_state.get("sessionAttributes") or {}

    @classmethod
    def from_event(cls, event):
        return cls(event)

    @property
    def intent_name(self):
        return self.intent.get("name")

    @property
    def invocation_source(self):
        return self.event.get("invocationSource")

    @property
    def input_transcript(self):
        return self.event.get("inputTranscript") or ""

    @property
    def proposed_slot(self):
        proposed = self.event.get("proposedNextState") or {}
        return (proposed.get("dialogAction") or {}).get("slotToElicit")

    def slot(self, slot_name):
        return get_slot_value(self.slots, slot_name)


class LexResponseBuilder:

    @staticmethod
    def _messages(message):
        return [{"contentType": "PlainText", "content": message}]

    @staticmethod
    def _intent(intent, slots, state="InProgress"):
        updated = dict(intent)
        updated["slots"] = slots
        updated["state"] = state
        return updated

    @classmethod
    def elicit_slot(cls, slot_name, message, attrs, intent, slots):
        return {
            "sessionState": {
                "sessionAttributes": attrs,
                "dialogAction": {"type": "ElicitSlot", "slotToElicit": slot_name},
                "intent": cls._intent(intent, slots, "InProgress"),
            },
            "messages": cls._messages(message),
        }

    @classmethod
    def delegate(cls, attrs, intent, slots):
        return {
            "sessionState": {
                "sessionAttributes": attrs,
                "dialogAction": {"type": "Delegate"},
                "intent": cls._intent(intent, slots, "InProgress"),
            }
        }

    @classmethod
    def close(cls, message, attrs, intent, slots, state="Failed"):
        return {
            "sessionState": {
                "sessionAttributes": attrs,
                "dialogAction": {"type": "Close"},
                "intent": cls._intent(intent, slots, state),
            },
            "messages": cls._messages(message),
        }


class SessionManager:

    LAST_ELICITED = "last_elicited"
    TURN_INPUT = "turn_input"
    TURN_RESULT = "turn_result"
    RETRY_PREFIX = "retry_"
    TURN_KEYS = (LAST_ELICITED, TURN_INPUT, TURN_RESULT)

    def __init__(self, attrs):
        self.attrs = attrs

    def get(self, key, default=""):
        return self.attrs.get(key, default)

    def set(self, key, value):
        self.attrs[key] = str(value)

    def get_retry_count(self, slot_name):
        return int(self.attrs.get(f"{self.RETRY_PREFIX}{slot_name}", "0"))

    def increment_retry(self, slot_name):
        count = self.get_retry_count(slot_name) + 1
        self.set(f"{self.RETRY_PREFIX}{slot_name}", count)
        return count

    def reset_progress(self):
        for key in list(self.attrs.keys()):
            if key.startswith(self.RETRY_PREFIX):
                self.attrs[key] = "0"
        for key in self.TURN_KEYS:
            if key in self.attrs:
                self.attrs[key] = ""

    def record_booking(self, booking_id, source, destination, start_date, end_date):
        self.set("last_booking_id", booking_id)
        self.set("last_booking_status", config.BOOKING_STATUS_CONFIRMED)
        self.set("last_source", source or "")
        self.set("last_destination", destination or "")
        self.set("last_start_date", start_date or "")
        self.set("last_end_date", end_date or "")


def log_intent(func):

    @functools.wraps(func)
    def wrapper(event, context=None):
        logger = get_logger()
        try:
            request = LexRequest.from_event(event)
            logger.info(_to_json({
                "stage": "request",
                "intent": request.intent_name,
                "invocationSource": request.invocation_source,
                "input": request.input_transcript,
                "slots": request.slots,
                "sessionAttributes": request.session_attributes,
            }))
            intent_name = request.intent_name
        except Exception:
            logger.warning("Unparseable event: %s", _to_json(event))
            intent_name = None

        response = func(event, context)

        logger.info(_to_json({
            "stage": "response",
            "intent": intent_name,
            "response": response,
        }))
        return response

    return wrapper


def handle_exceptions(func):

    @functools.wraps(func)
    def wrapper(event, context=None):
        try:
            return func(event, context)
        except Exception as exc:
            get_logger().error(
                "Unhandled error: %s\n%s\nEvent: %s",
                exc,
                traceback.format_exc(),
                _to_json(event),
            )
            return _safe_failure_response(event)

    return wrapper


def _safe_failure_response(event):
    try:
        request = LexRequest.from_event(event)
        return LexResponseBuilder.close(
            config.ERROR_MESSAGE,
            request.session_attributes,
            request.intent,
            request.slots,
            state="Failed",
        )
    except Exception: 
        return {
            "sessionState": {
                "dialogAction": {"type": "Close"},
                "intent": {"name": "Unknown", "state": "Failed"},
            },
            "messages": LexResponseBuilder._messages(config.ERROR_MESSAGE),
        }