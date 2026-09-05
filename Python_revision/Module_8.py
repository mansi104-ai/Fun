# #Generator
# def count_to_n(n):
#   i = 1
#   while i<= n:
#     yield i
#     i+= 1
# for num in count_to_n(5):
#   print(num) ##Used for streaming responses in agentic like applications

# ##Generator expression
# total = sum(x**2 for x in range(1_000_000))
# print(total)

#Decorator
import time
from functools import wraps
def timer(func):
  @wraps(func)
  def wrapper(*args,**kwargs):
    start  = time.time()
    result = func(*args, *kwargs)
    print(f"{func.__name__} took {time.time() - start:.4f}")
    return result
  return wrapper

@timer # This means slow_square = timer(slow_square)
def slow_square(n):
  time.sleep(0.1)
  return n*n
slow_square(5)