"""Reference solutions. Try practice.py first!  Run: python solutions.py"""
import asyncio
import time


# ============ Part 1: iterators & iterables ============

class Countdown:
    """An ITERATOR: has __next__, and __iter__ returns itself (single use)."""

    def __init__(self, start):
        self.current = start

    def __iter__(self):
        return self

    def __next__(self):
        if self.current <= 0:
            raise StopIteration
        value = self.current
        self.current -= 1
        return value


class _PlaylistIterator:
    def __init__(self, songs):
        self._songs = songs
        self._i = 0

    def __iter__(self):
        return self

    def __next__(self):
        if self._i >= len(self._songs):
            raise StopIteration
        song = self._songs[self._i]
        self._i += 1
        return song


class Playlist:
    """An ITERABLE: __iter__ hands out a NEW iterator every time."""

    def __init__(self, songs):
        self.songs = list(songs)

    def __iter__(self):
        return _PlaylistIterator(self.songs)


def manual_for(iterable):
    result = []
    it = iter(iterable)
    while True:
        try:
            item = next(it)
        except StopIteration:
            break
        result.append(item)
    return result


def read_chunks(fileobj, size):
    # iter(callable, sentinel) calls the callable until it returns the sentinel
    return iter(lambda: fileobj.read(size), "")


# ============ Part 2: generators ============

def fibonacci():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b


def batched(iterable, n):
    batch = []
    for item in iterable:
        batch.append(item)
        if len(batch) == n:
            yield batch
            batch = []
    if batch:
        yield batch


def flatten(nested):
    for item in nested:
        if isinstance(item, (list, tuple)):
            yield from flatten(item)
        else:
            yield item


def running_average():
    total = 0
    count = 0
    average = None
    while True:
        value = yield average
        total += value
        count += 1
        average = total / count


def even_squares(numbers):
    return (n * n for n in numbers if n % 2 == 0)


# ============ Part 3: async / await ============

async def fetch(name, delay):
    await asyncio.sleep(delay)
    return f"{name} done"


async def run_concurrently(names, delay):
    return await asyncio.gather(*(fetch(n, delay) for n in names))


async def first_completed(jobs):
    tasks = [asyncio.create_task(fetch(name, delay)) for name, delay in jobs]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    return done.pop().result()


async def ticker(n, delay):
    for i in range(n):
        await asyncio.sleep(delay)
        yield i


async def collect(agen):
    return [item async for item in agen]


async def bounded_gather(job_factories, limit):
    sem = asyncio.Semaphore(limit)

    async def guarded(factory):
        async with sem:
            return await factory()

    return await asyncio.gather(*(guarded(f) for f in job_factories))


async def with_timeout(coro, seconds):
    try:
        return await asyncio.wait_for(coro, timeout=seconds)
    except asyncio.TimeoutError:
        return None


async def run_blocking(fn, *args):
    return await asyncio.to_thread(fn, *args)


# ============ Part 4: event loop ============

async def order_demo():
    log = []

    async def worker(name):
        log.append(f"{name} start")
        await asyncio.sleep(0)  # yields control back to the event loop
        log.append(f"{name} end")

    t1 = asyncio.create_task(worker("A"))
    t2 = asyncio.create_task(worker("B"))
    log.append("main before await")
    await asyncio.gather(t1, t2)
    log.append("main after")
    return log


# create_task only SCHEDULES; the tasks don't run until main hits an await.
# Each worker yields at sleep(0), so they interleave: A, B, A, B.
EXPECTED_ORDER = [
    "main before await",
    "A start",
    "B start",
    "A end",
    "B end",
    "main after",
]


async def current_loop_info():
    loop = asyncio.get_running_loop()

    async def inner():
        return asyncio.get_running_loop()

    inner_loop = await asyncio.create_task(inner())
    return {"running": loop.is_running(), "same_loop_in_task": inner_loop is loop}


if __name__ == "__main__":
    import sys
    from checks import run
    run(sys.modules[__name__])