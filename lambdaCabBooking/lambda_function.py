import os
print("FILES:", os.listdir(os.path.dirname(os.path.abspath(__file__))))
from handlers import (
    BookCabHandler,
    FallbackHandler,
    GreetingHandler,
)

from utils import (
    LexRequest,
    handle_exceptions,
    log_intent,
)


INTENT_HANDLERS = {
    "GreetUser2": GreetingHandler(),
    "BookCab": BookCabHandler(),
}

FALLBACK = FallbackHandler()

@handle_exceptions
@log_intent
def lambda_handler(event, context):

    request = LexRequest.from_event(event)

    handler = INTENT_HANDLERS.get(
        request.intent_name,
        FALLBACK,
    )

    return handler.handle(request)