# def safe_divide(a,b):
#   try:
#     result = a/b
#   except ZeroDivisionError:
#     print("Can't divide by zero")
#     return None
#   except TypeError:
#     print("Both arguments must be numbers")
#     return None
#   else:
#     print("Division succeeded")
#     return result
#   finally: 
#     print("Done attempting Division")

# print(safe_divide(8,4))

##Class Exception
# class InsufficientFundsError(Exception):
#   pass
# def withdraw(balance, amount):
#   if amount > balance:
#     raise InsufficientFundsError("Not enough balance")
#   return balance -amount

# try: 
#   withdraw(100,50)
# except InsufficientFundsError as e:
#   print(f"Caught: {e}")
# else:
#   print(withdraw(100,50))

# print(withdraw(5,2))

##File I/O  --"with" auto closes the file even on error
# with open("Notes.txt","w") as f:
#   f.write("Practice python basics .\n")

# with open("Notes.txt","r") as f:
#   content = f.read()
# print(content)

## With is a context manager, it runs __enter__ on entry and gurantees __exit__ even if an exception occurs 
##Without "with" statement we would require a seperate try/finally: f.close() statement

##Hands-on-1
# def safe_divide(a,b):
#   try:
#     result = a/b
#   except ZeroDivisionError:
#     print("Cannot divide by 0")
#     return None
#   except TypeError:
#     print("Both arguments must be number")
#     return None
#   else:
#     print("Division succeeded")
#     return result
#   finally:
#     print("Done doing division")

# print(safe_divide(10,2))

##Hands-on -2

##Hands-on 3
# with open("Notes.txt","r") as f:
#   lines = f.readlines()
# print(len(lines))

##Hands-on 4
# val = input("please enter a value: ")
# try:
#   value = int(val)
#   print(f"Your input is {value}")
# except ValueError:
#   print("Input is not a number")
# finally:
#   print("input taken")



