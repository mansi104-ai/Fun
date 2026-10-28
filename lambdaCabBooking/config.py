
MAX_RETRIES = 1

# Date handling
LEX_DATE_FORMAT = "%Y-%m-%d"  
DISPLAY_DATE_FORMAT = "%d %b %Y" 
UTC_OFFSET_HOURS = 5  
UTC_OFFSET_MINUTES = 30
PAST_DATE_GRACE_DAYS = 1

# Booking
BOOKING_ID_PREFIX = "CAB-"
BOOKING_ID_TIME_FORMAT = "%Y%m%d%H%M%S"
BOOKING_STATUS_CONFIRMED = "CONFIRMED"

# Logging
LOGGER_NAME = "lex_cab_bot"
LOG_LEVEL = "INFO"
LOG_FILE_PATH = "/tmp/lex_intent_logs.log" 
LOG_MAX_BYTES = 1_000_000
LOG_BACKUP_COUNT = 3

# Slot prompts
SLOT_PROMPTS = {
    "source": "Which city should we pick you up from?",
    "destination": "Where would you like to go?",
    "startDate": "On which date do you want to travel? For example, {example_date}.",
    "endDate": "And on which date will you be returning? For example, {example_date}.",
}

# Retry prompts
RETRY_MESSAGES = {
    "source": "Sorry, I didn't recognise that city. Please tell me the city you'd like to be picked up from.",
    "destination": "Sorry, I didn't recognise that city. Please tell me the city you want to travel to.",
    "startDate": "Sorry, I couldn't read that date. Please enter your travel date like {example_date}.",
    "endDate": "Sorry, I couldn't read that date. Please enter your return date like {example_date}.",
}
INVALID_RETRY = "Sorry, I couldn't understand that. Please try again."

# Validation messages
SAME_SOURCE_DESTINATION = (
    "Pickup and drop cities can't be the same. "
    "Please tell me a different destination city."
)
WRONG_DATE_FORMAT = "Please enter your start date again, for example {example_date}."
PAST_DATE_MESSAGE = (
    "I understood your start date as {start_date}, which is in the past. "
    + WRONG_DATE_FORMAT
)
RETURN_BEFORE_START_MESSAGE = (
    "I understood your start date as {start_date} and your return date as "
    "{end_date}. The return date can't be before the start date. "
    + WRONG_DATE_FORMAT
)

# Conversation messages
GREETING_MESSAGE = "Hello! I can help you book a cab. Say 'book a cab' to get started."
CLOSING_FAIL = "Sorry, I couldn't process your request."
ERROR_MESSAGE = "Something went wrong on my side. Please try again in a moment."
BOOKING_FAILURE = "I cannot complete the cab booking."
RETRIES_EXCEEDED_MESSAGE = (
    "I couldn't get a valid {slot} after {retries} retry. {failure}"
)
BOOKING_SUCCESS_MESSAGE = (
    "Cab booking successful. Booking ID: {booking_id}. "
    "From {source} to {destination}. Start date: {start_date}."
)
BOOKING_RETURN_SUFFIX = " Return date: {end_date}."