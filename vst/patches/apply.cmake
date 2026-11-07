# Applies a patch to the fetched JUCE once (a second configure finds it applied and leaves it).
#   cmake -DPATCH=<file> -P apply.cmake   (run in the source tree)
execute_process(COMMAND git apply --reverse --check ${PATCH} RESULT_VARIABLE applied OUTPUT_QUIET ERROR_QUIET)
if(NOT applied EQUAL 0)
  execute_process(COMMAND git apply ${PATCH} RESULT_VARIABLE r)
  if(NOT r EQUAL 0)
    message(FATAL_ERROR "couldn't apply ${PATCH}")
  endif()
endif()
