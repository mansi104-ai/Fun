"""
Python practice: iterators, iterables, generators, async/await, event loop.

How to use
----------
1. Read each exercise, replace `raise NotImplementedError` with your code.
2. Run:  python practice.py
   You'll see [PASS] / [FAIL] / [TODO] per exercise, with hints on failures.
3. Stuck? Peek at solutions.py (try for 10+ min first!).

Quick refresher
---------------
- Iterable : has __iter__() returning an iterator   (list, str, dict, your Playlist)
- Iterator : has __next__() and __iter__() returning self; raises StopIteration when done
- Generator: a function with `yield` -> gives you an iterator for free, lazily
- Coroutine: `async def` function; calling it returns a coroutine object, nothing runs yet
- Event loop: single-threaded scheduler; runs a task until it hits `await`, then switches
"""
import asyncio  # noqa: F401  (you'll need it in Part 3 and 4)
import time     # noqa: F401


# =====================================================================
# PART 1: ITERATORS & ITERABLES
# =====================================================================

# 1.1  Write an ITERATOR class.
#      Countdown(3) should yield 3, 2, 1 and then stop.
#      Remember: __iter__ returns self, __next__ raises StopIteration at the end.
class Countdown:
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

# 1.2  Write an ITERABLE class (not an iterator!).
#      Playlist(["a", "b"]) must be loopable many times:
#          for s in p: ...   # works
#          for s in p: ...   # works again
#      Hint: __iter__ should return a NEW iterator object each call
#      (you can write a small helper iterator class, or return iter(self.songs)).
class Playlist:
    def __init__(self, songs):
        self.songs = songs

    def __iter__(self):
        return iter(self.songs)
        
# 1.3  Re-implement what a `for` loop does under the hood.
#      Return a list of all items, using ONLY iter(), next(), and try/except StopIteration.
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
        
# 1.4  Two-argument iter(callable, sentinel).
#      Return an iterator that yields fileobj.read(size) chunks until read() returns "".
#      One line is enough.
def read_chunks(fileobj, size):
  return iter(lambda: fileobj.read(size), "")
  
# =====================================================================
# PART 2: GENERATORS
# =====================================================================

# 2.1  Infinite generator of Fibonacci numbers: 0, 1, 1, 2, 3, 5, 8, ...
def fibonacci():
    raise NotImplementedError


# 2.2  batched(range(7), 3) -> [0,1,2], [3,4,5], [6]   (yield LISTS, last one may be shorter)
#      Must be a generator, so it works on huge/infinite inputs.
def batched(iterable, n):
    raise NotImplementedError


# 2.3  flatten([1, [2, [3, 4]], 5]) -> 1, 2, 3, 4, 5
#      Use `yield from` and recursion. Treat only list/tuple as nested (strings stay whole).
def flatten(nested):
    raise NotImplementedError


# 2.4  A generator used as a COROUTINE via send().
#          g = running_average(); next(g)   # "prime" it
#          g.send(10) -> 10.0
#          g.send(20) -> 15.0
#      Hint: `value = yield average` both returns a value and receives one.
def running_average():
    raise NotImplementedError


# 2.5  Return a lazy generator EXPRESSION of the squares of the even numbers.
#      Nothing should be consumed from `numbers` until the caller iterates.
#      (Return a generator expression -- not a list comprehension!)
def even_squares(numbers):
    raise NotImplementedError


# =====================================================================
# PART 3: ASYNC / AWAIT
# =====================================================================

# 3.1  Simulate a network call: wait `delay` seconds (non-blocking!) then return "<name> done".
async def fetch(name, delay):
    raise NotImplementedError


# 3.2  Run fetch(name, delay) for every name CONCURRENTLY and return results in input order.
#      3 names x 0.3s should take ~0.3s total, not 0.9s.   Hint: asyncio.gather
async def run_concurrently(names, delay):
    raise NotImplementedError


# 3.3  jobs is a list of (name, delay). Return the result of whichever fetch finishes FIRST,
#      and cancel the rest (don't leave them running).
#      Hint: asyncio.create_task + asyncio.wait(..., return_when=FIRST_COMPLETED)
async def first_completed(jobs):
    raise NotImplementedError


# 3.4  ASYNC GENERATOR: yield 0..n-1, awaiting asyncio.sleep(delay) before each item.
#      Then write collect() that gathers everything from an async generator into a list
#      using `async for` (or an async comprehension).
async def ticker(n, delay):
    raise NotImplementedError


async def collect(agen):
    raise NotImplementedError


# 3.5  job_factories is a list of zero-arg async functions. Run them all concurrently
#      but with at most `limit` running at the same time. Return results in order.
#      Hint: asyncio.Semaphore with `async with`.
async def bounded_gather(job_factories, limit):
    raise NotImplementedError


# 3.6  Await `coro`, but give up after `seconds` and return None instead of raising.
#      Hint: asyncio.wait_for + except asyncio.TimeoutError
async def with_timeout(coro, seconds):
    raise NotImplementedError


# 3.7  fn is a regular BLOCKING function (like time.sleep or requests.get).
#      Run it without freezing the event loop, so two blocking calls can overlap.
#      Hint: asyncio.to_thread
async def run_blocking(fn, *args):
    raise NotImplementedError


# =====================================================================
# PART 4: THE EVENT LOOP
# =====================================================================

# 4.1  PREDICT THE OUTPUT. Read order_demo(), think it through on paper, then fill in
#      EXPECTED_ORDER with the list you think it returns. (Then run it and see!)
#      Questions to ask: When does a task created with create_task actually start?
#      What does `await asyncio.sleep(0)` do?
async def order_demo():
    log = []

    async def worker(name):
        log.append(f"{name} start")
        await asyncio.sleep(0)
        log.append(f"{name} end")

    t1 = asyncio.create_task(worker("A"))
    t2 = asyncio.create_task(worker("B"))
    log.append("main before await")
    await asyncio.gather(t1, t2)
    log.append("main after")
    return log


EXPECTED_ORDER = None  # e.g. ["main before await", "A start", ...]


# 4.2  Return {"running": <is the current loop running?>,
#              "same_loop_in_task": <does a task spawned from here see the SAME loop?>}
#      Hint: asyncio.get_running_loop(), loop.is_running(), create_task
async def current_loop_info():
    raise NotImplementedError


# =====================================================================
# BONUS CHALLENGES (no checker -- just try them!)
# =====================================================================
# B1. Make Countdown also work in `reversed()` by adding __reversed__ (what should it return?).
# B2. Write a generator `pipeline(path)` that lazily reads a big file, strips lines, drops
#     blanks, and uppercases -- chaining 3 generators. Check memory stays flat.
# B3. Write an async `retry(coro_factory, attempts, delay)` with exponential backoff.
# B4. Write an async producer/consumer with asyncio.Queue: 1 producer, 3 consumers,
#     shut down cleanly with sentinel values.
# B5. Show what happens if you call time.sleep(1) inside an async def that is gathered
#     with 3 others. Then fix it two ways (asyncio.sleep vs to_thread).


if __name__ == "__main__":
    import sys
    from checks import run
    run(sys.modules[__name__])