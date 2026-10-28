from abc import ABC, abstractmethod
from datetime import timedelta

import config

from utils import (
    DateUtils,
    LexResponseBuilder,
    SessionManager,
    get_logger,
)

from validators import validate_filled_slots


logger = get_logger()
builder = LexResponseBuilder


class BaseHandler(ABC):

    @abstractmethod
    def handle(self, request):
        pass

    @staticmethod
    def _example_date(slot_name, request):
        # Start date example: tomorrow.
        # Return date example: the day after the chosen start date.
        base = DateUtils.today()
        if slot_name == "endDate" and request is not None:
            start = DateUtils.parse(request.slot("startDate"))
            if start and start >= base:
                base = start
        return DateUtils.format(base + timedelta(days=1))

    @classmethod
    def slot_prompt(cls, slot_name, request=None):
        template = config.SLOT_PROMPTS.get(slot_name, config.INVALID_RETRY)
        return template.format(example_date=cls._example_date(slot_name, request))

    @classmethod
    def retry_prompt(cls, slot_name, request=None):
        template = config.RETRY_MESSAGES.get(slot_name, config.INVALID_RETRY)
        return template.format(example_date=cls._example_date(slot_name, request))


class GreetingHandler(BaseHandler):

    def handle(self, request):
        logger.info(
            "GreetingHandler invoked | intent=%s | source=%s",
            request.intent_name,
            request.invocation_source,
        )
        return builder.close(
            config.GREETING_MESSAGE,
            request.session_attributes,
            request.intent,
            request.slots,
            state="Fulfilled",
        )


class BookCabHandler(BaseHandler):

    def handle(self, request):
        logger.info(
            "BookCabHandler invoked | intent=%s | source=%s",
            request.intent_name,
            request.invocation_source,
        )

        if request.invocation_source == "DialogCodeHook":
            return self.handle_dialog(request)

        if request.invocation_source == "FulfillmentCodeHook":
            return self.handle_fulfillment(request)

        logger.warning("Unknown invocation source: %s", request.invocation_source)
        return FallbackHandler().handle(request)

    def _elicit_retry(self, slot_name, request):
        logger.info("Retrying slot: %s", slot_name)
        return builder.elicit_slot(
            slot_name,
            self.retry_prompt(slot_name, request),
            request.session_attributes,
            request.intent,
            request.slots,
        )

    def _on_validation_problem(self, problem, request):
        logger.warning(
            "Validation problem | slot=%s | message=%s",
            problem.slot_to_elicit,
            problem.message,
        )

        session = SessionManager(request.session_attributes)

        # FIX: count validation failures too, otherwise a user who keeps entering an invalid value is looped forever.
        retry_count = session.increment_retry(problem.slot_to_elicit)
        if retry_count > config.MAX_RETRIES:
            return self._on_retries_exceeded(problem.slot_to_elicit, request)

        for name in problem.slots_to_clear:
            request.slots[name] = None

        session.set(SessionManager.LAST_ELICITED, problem.slot_to_elicit)

        return builder.elicit_slot(
            problem.slot_to_elicit,
            problem.message,
            request.session_attributes,
            request.intent,
            request.slots,
        )

    def _on_retries_exceeded(self, slot_name, request):
        session = SessionManager(request.session_attributes)
        session.reset_progress()

        message = config.RETRIES_EXCEEDED_MESSAGE.format(
            slot=slot_name,
            retries=config.MAX_RETRIES,
            failure=config.BOOKING_FAILURE,
        )

        return builder.close(
            message,
            request.session_attributes,
            request.intent,
            request.slots,
            state="Failed",
        )

    def handle_dialog(self, request):
        session = SessionManager(request.session_attributes)

        turn_input = request.input_transcript
        next_slot = request.proposed_slot

        logger.info(
            "Dialog turn | input=%r | next_slot=%s | slots=%s",
            turn_input,
            next_slot,
            request.slots,
        )

        # 1. Validate already-filled slots
        problem = validate_filled_slots(request.slots)
        if problem:
            return self._on_validation_problem(problem, request)

        # 2. Nothing left to elicit
        if not next_slot:
            logger.info("No next slot. Delegating to Lex.")
            session.reset_progress()
            return builder.delegate(
                request.session_attributes,
                request.intent,
                request.slots,
            )

        # 3. Was the slot rejected by Lex (same slot proposed again)?
        rejected = session.get(SessionManager.LAST_ELICITED) == next_slot

        session.set(SessionManager.LAST_ELICITED, next_slot)

        # 4. First attempt: ask using our own prompt from config.SLOT_PROMPTS
        if not rejected:
            logger.info("First attempt for slot: %s", next_slot)
            session.set(SessionManager.TURN_RESULT, "delegate")
            return builder.elicit_slot(
                next_slot,
                self.slot_prompt(next_slot, request),
                request.session_attributes,
                request.intent,
                request.slots,
            )

        # 5. Retry
        retry_count = session.increment_retry(next_slot)
        logger.info("Retry count | slot=%s | count=%s", next_slot, retry_count)

        if retry_count > config.MAX_RETRIES:
            return self._on_retries_exceeded(next_slot, request)

        session.set(SessionManager.TURN_RESULT, "elicit")
        return self._elicit_retry(next_slot, request)

    def handle_fulfillment(self, request):
        logger.info("Processing cab booking fulfillment.")

        source = request.slot("source")
        destination = request.slot("destination")
        start_date = request.slot("startDate")
        end_date = request.slot("endDate")

        logger.info(
            "Booking slots | source=%s | destination=%s | startDate=%s | endDate=%s",
            source,
            destination,
            start_date,
            end_date,
        )

        booking_id = config.BOOKING_ID_PREFIX + DateUtils.now().strftime(
            config.BOOKING_ID_TIME_FORMAT
        )

        message = config.BOOKING_SUCCESS_MESSAGE.format(
            booking_id=booking_id,
            source=source,
            destination=destination,
            start_date=DateUtils.format(start_date),
        )

        if end_date:
            message += config.BOOKING_RETURN_SUFFIX.format(
                end_date=DateUtils.format(end_date)
            )

        session = SessionManager(request.session_attributes)
        session.reset_progress()
        session.record_booking(booking_id, source, destination, start_date, end_date)

        return builder.close(
            message,
            request.session_attributes,
            request.intent,
            request.slots,
            state="Fulfilled",
        )


class FallbackHandler(BaseHandler):

    def handle(self, request):
        logger.warning(
            "FallbackHandler invoked | intent=%s | source=%s",
            request.intent_name,
            request.invocation_source,
        )
        return builder.close(
            config.CLOSING_FAIL,
            request.session_attributes,
            request.intent,
            request.slots,
            state="Failed",
        )