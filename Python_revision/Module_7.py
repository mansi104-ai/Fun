##Comprehensions -> way to create a new collection
squares = [n**2 for n in range(1,11)]
evens = [n for n in range(20) if n%2  == 0]
square_map = {n: n**2 for n in range(1,6)}
unique_lengths= {len(word) for word in ["hi","bye","ok","see"]}

##Pattern : [expression for variable in iterable]

##evens means -> list.append(n) where n is the variable in the range 0 ->20 only if n is even
##square_map -> Make a dictionary of key : value , where key is n and the value is n squared for variable n in iterable 1,6
##unique lengths -> expression is len(word) for variable word in iterable of a list


##Lambdas + map/filter/sorted -> anonymous function
nums = [5,3,8,1,9]
doubled = list(map(lambda x : x*2, nums)) # map is used to route one thing to the second

over_four = list(filter(lambda x: x>4, nums))
#Take x and tell me whether x is greater than 4

people = [
  ("Mansi", 25),
  ("Rahul", 30),
  ("Ana",22)
]

by_age = sorted(people, key= lambda p:p[1])
#For each person, use their age as the sorting value
#lambda arguments: expression

##Modules:
import math
import random
import datetime as date
from collections import Counter

print(math.sqrt(6))
print(random.choice(["heads","tails"]))
print(date.time)
print(Counter("mississippi"))

##Rule of thumb: Use comprehensions for only 1 if/nested loop, to make code more readable
