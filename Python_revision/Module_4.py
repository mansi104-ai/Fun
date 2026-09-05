##Arguments and keyword agruments
# def greet(name, greeting = "Hello"):
#   return f"{greeting}, {name}!"

# print(greet("Mansi"))
# print(greet("Mansi",greeting = "Hey"))

# def total(*args, **kwargs):
#   print("positional:" ,args)
#   print("keyword: ", kwargs)
# total(1,2,3,tax = 0.1, currency = "INR")

##Scope
# x = "global"
# def show_scope():
#   x = "local"
#   print(x)
# show_scope()
# print(x)  #global x is untouched

##Hands-on 1
# def factorial(n):
#     result = 1
#     for i in range(1, n + 1):
#         result *= i
#     return result

# print(factorial(5))

##Hands-on 2 
# def avg(*nums):
#   return sum(nums) / len(nums) if nums else 0
# print(avg(1,2,3,4))

##Hands-on 3
def describe_person(name, **kwargs):
  print(f"Name: {name}")
  for key, value in kwargs.items():
    print(f"{key} : {value}")

describe_person("Mansi",role = "developer", company = "EXL")

    
