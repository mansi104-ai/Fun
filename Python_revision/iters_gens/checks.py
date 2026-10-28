"""Self-checker. You don't need to edit this file.

Run:  python practice.py      (your attempt)
      python solutions.py     (reference answers)
"""
import asyncio
import inspect
import io
import itertools
import time
import types
import warnings


def run(m):
    warnings.filterwarnings("ignore", category=RuntimeWarning)
    results = []

    def check(name, fn):
        try:
            fn()
            results.append((name, "PASS", ""))
        except NotImplementedError:
            results.append((name, "TODO", ""))
        except AssertionError as e:
            results.append((name, "FAIL", str(e) or "assertion failed"))
        except Exception as e:  # noqa: BLE001
            results.append((name, "ERROR", f"{type(e).__name__}: {e}"))

    # ---------------- Part 1: iterators & iterables ----------------
    def t_countdown():
        c = m.Countdown(3)
        assert iter(c) is c, "an iterator's __iter__ must return itself"
        assert list(c) == [3, 2, 1], "Countdown(3) should yield 3, 2, 1"
        try:
            next(c)
        except StopIteration:
            pass
        else:
            raise AssertionError("an exhausted iterator must keep raising StopIteration")

    def t_playlist():
        p = m.Playlist(["a", "b", "c"])
        assert list(p) == ["a", "b", "c"]
        assert list(p) == ["a", "b", "c"], "an iterable must be re-loopable (return a NEW iterator)"
        assert iter(p) is not iter(p), "__iter__ should return a fresh iterator each time"
        assert not hasattr(p, "__next__"), "an iterable should not itself be an iterator"

    def t_manual_for():
        assert m.manual_for([1, 2, 3]) == [1, 2, 3]
        assert m.manual_for("hey") == ["h", "e", "y"]
        assert m.manual_for(iter([])) == []

    def t_read_chunks():
        f = io.StringIO("abcdefgh")
        assert list(m.read_chunks(f, 3)) == ["abc", "def", "gh"]

    check("1.1 Countdown (iterator class)", t_countdown)
    check("1.2 Playlist (iterable class)", t_playlist)
    check("1.3 manual_for (iter/next/StopIteration)", t_manual_for)
    check("1.4 read_chunks (two-argument iter)", t_read_chunks)

    # ---------------- Part 2: generators ----------------
    def t_fib():
        g = m.fibonacci()
        assert inspect.isgenerator(g), "fibonacci() should be a generator function"
        assert list(itertools.islice(g, 8)) == [0, 1, 1, 2, 3, 5, 8, 13]

    def t_batched():
        assert list(m.batched(range(7), 3)) == [[0, 1, 2], [3, 4, 5], [6]]
        assert list(m.batched([], 3)) == []
        assert inspect.isgenerator(m.batched([1], 1))

    def t_flatten():
        assert list(m.flatten([1, [2, [3, 4]], 5])) == [1, 2, 3, 4, 5]
        assert list(m.flatten(["ab", ["cd"]])) == ["ab", "cd"], "don't split strings into characters"

    def t_running_avg():
        g = m.running_average()
        next(g)  # prime the coroutine
        assert g.send(10) == 10
        assert g.send(20) == 15
        assert g.send(60) == 30

    def t_lazy_pipeline():
        consumed = []

        def source():
            for i in range(1, 100):
                consumed.append(i)
                yield i

        result = m.even_squares(source())
        assert isinstance(result, types.GeneratorType), "return a generator expression, not a list"
        assert consumed == [], "nothing should be consumed until you iterate"
        assert next(result) == 4
        assert consumed == [1, 2], "should be lazy: only pulled 1 and 2 so far"

    check("2.1 fibonacci (infinite generator)", t_fib)
    check("2.2 batched (generator with state)", t_batched)
    check("2.3 flatten (yield from + recursion)", t_flatten)
    check("2.4 running_average (send())", t_running_avg)
    check("2.5 even_squares (lazy generator expression)", t_lazy_pipeline)

    # ---------------- Part 3: async / await ----------------
    def t_fetch():
        assert asyncio.run(m.fetch("x", 0.01)) == "x done"
        assert inspect.iscoroutinefunction(m.fetch), "fetch must be `async def`"

    def t_concurrent():
        start = time.perf_counter()
        res = asyncio.run(m.run_concurrently(["a", "b", "c"], 0.3))
        elapsed = time.perf_counter() - start
        assert res == ["a done", "b done", "c done"], "results should keep input order"
        assert elapsed < 0.6, f"took {elapsed:.2f}s - that is sequential, not concurrent"

    def t_first():
        async def go():
            return await m.first_completed([("slow", 0.5), ("fast", 0.05), ("mid", 0.2)])

        start = time.perf_counter()
        res = asyncio.run(go())
        elapsed = time.perf_counter() - start
        assert res == "fast done"
        assert elapsed < 0.3, "the slower tasks should be cancelled, not awaited"

    def t_agen():
        async def go():
            gen = m.ticker(3, 0.01)
            if not inspect.isasyncgen(gen):
                await gen  # an untouched stub raises NotImplementedError here
                raise AssertionError("ticker must be an async generator (use `yield` inside async def)")
            return await m.collect(gen)

        assert asyncio.run(go()) == [0, 1, 2]

    def t_bounded():
        running = 0
        peak = 0

        async def job():
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.05)
            running -= 1
            return 1

        res = asyncio.run(m.bounded_gather([job for _ in range(10)], limit=3))
        assert res == [1] * 10
        assert peak == 3, f"peak concurrency was {peak}, expected exactly 3"

    def t_timeout():
        async def go():
            slow = m.fetch("slow", 0.5)
            fast = m.fetch("fast", 0.01)
            return await m.with_timeout(slow, 0.1), await m.with_timeout(fast, 0.1)

        assert asyncio.run(go()) == (None, "fast done")

    def t_blocking():
        start = time.perf_counter()

        async def go():
            return await asyncio.gather(
                m.run_blocking(time.sleep, 0.3), m.run_blocking(time.sleep, 0.3)
            )

        asyncio.run(go())
        elapsed = time.perf_counter() - start
        assert elapsed < 0.55, f"took {elapsed:.2f}s - blocking calls ran one after another"

    check("3.1 fetch (basic coroutine)", t_fetch)
    check("3.2 run_concurrently (gather)", t_concurrent)
    check("3.3 first_completed (wait + cancel)", t_first)
    check("3.4 ticker + collect (async generator / async for)", t_agen)
    check("3.5 bounded_gather (Semaphore)", t_bounded)
    check("3.6 with_timeout (timeouts)", t_timeout)
    check("3.7 run_blocking (to_thread)", t_blocking)

    # ---------------- Part 4: event loop ----------------
    def t_order():
        if m.EXPECTED_ORDER is None:
            raise NotImplementedError
        log = asyncio.run(m.order_demo())
        assert m.EXPECTED_ORDER == log, f"actual order was: {log}"

    def t_loop():
        loop = asyncio.run(m.current_loop_info())
        assert loop == {"running": True, "same_loop_in_task": True}, loop

    check("4.1 predict the order (event loop scheduling)", t_order)
    check("4.2 current_loop_info (get_running_loop)", t_loop)

    # ---------------- report ----------------
    icons = {"PASS": "[PASS]", "FAIL": "[FAIL]", "ERROR": "[ERR ]", "TODO": "[TODO]"}
    print()
    for name, status, msg in results:
        print(f"{icons[status]} {name}" + (f"\n         -> {msg}" if msg else ""))
    passed = sum(s == "PASS" for _, s, _ in results)
    print(f"\n{passed}/{len(results)} exercises passing\n")