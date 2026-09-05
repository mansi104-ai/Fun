# from itertools import islice
# def fibonacci_number():
#   i = 1
#   while i:
#     yield i
#     i*= 2
#      ## infinite generator
# gen = fibonacci_number()

# first_10 = list(islice(gen,10))
# print(type(first_10))
# print(first_10)

from functools import wraps
def log_calls(func):
  @wraps(func)
  ##To preserve the metadata of the original function 
  def wrapper(*args,**kwargs):
    print(f"{func.__name__} took arguments {[type(arg).__name__ for arg in args]} and kwargs {kwargs}")
    ## __name__ to return the name of the type instead of actual type object
  return wrapper

@log_calls
def add(a,b):
  return a, b

add(1,"apple")

#What keyword turns a function into a generator : yield
#func = decorator(func)

  


