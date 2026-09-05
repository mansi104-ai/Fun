##Strings
# s = "Hello, world"
# print(s.lower(), s.upper(), s.split(","), s[::-1])
## ::-1 to reverse the string

##Lists and tuples
# my_list = [1,2,3] #mutable
# my_list.append(4)
# my_tuple = (1,2,3) #immutable
# my_tuple[0] = 9

##Dicts
# d = {"name" : "Mansi","role" : "developer"}
# d["years"] = 2
# print(d.get("missing_key", "default_value"))

#Sets
# a = {1,2,3}
# b = {4,5,6}
# print(a | b, a & b, a-b)

##Slicing  (works on strings, lists and tuples)
# nums = [0,1,2,3,4]
# print(nums[1:4], nums[:3], nums[::-1], nums[::2])

##Hands-on 1
# string = "Never Odd or Even"
# string = string.lower()
# final_str = ""
# for i in range (len(string)):
#   if string[i] != " ":
#     final_str += string[i]
# str_1 = final_str[::-1]
# print(str_1)
# print(final_str)
# print(str_1 == final_str)

##Hands-on 2
# i = 0
# string = "hello world I am Mansi"
# lst = string.split(" ")
# lst.reverse()
# for i in range(len(lst)):
#   print(lst[i], end = " ")

##Hands-on 3
# def dedup(lst):
#   seen = set()
#   result = []
#   for x in lst:
#     if x not in seen:
#       result.append(x)
#       seen.append(x)

#   return result

##Hands-on 4 
# d1 = {"a":1, "b" : 2}
# d2 = {"b" : 3, "c": 4}
# merged = {**d1, **d2}
# print(merged)

##Hands-on 5(a) -> Given a list sort it 
# nums = [5,3,8,9,1]
# nums.sort()
# nums.sort(reverse=True)
# print(nums)

##Hands-on 5(b) -> find the second largest, no sorting
# nums = [5,3,8,9,1]
# largest = nums[0]
# largest_2 = nums[1]
# if largest_2 > largest:
#   largest_2 = largest

# for i in range(1,len(nums)):
#   if nums[i] > largest:
#     largest_2 = largest
#     largest = nums[i]
#   elif nums[i] > largest_2:
#     largest_2= nums[2]
# print(largest_2)

##Average time for lookup is O(1) and average time for lookup is O(n)
# string = "a,b,,c"
# print(string.split(","))
