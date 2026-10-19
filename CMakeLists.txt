cmake_minimum_required(VERSION 3.28...3.30)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/common/bootstrap.cmake" NO_POLICY_SCOPE)

project(${_name} VERSION ${_version})

option(ENABLE_FRONTEND_API "Use obs-frontend-api for UI functionality" ON)
option(ENABLE_QT "Use Qt functionality" ON)

include(compilerconfig)
include(defaults)
include(helpers)

add_library(${CMAKE_PROJECT_NAME} MODULE)

find_package(libobs REQUIRED)
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE OBS::libobs)

# Studio Host needs the frontend API (dock, scenes, Tools menu) and Qt (dock widget, child process).
if(NOT ENABLE_FRONTEND_API OR NOT ENABLE_QT)
  message(FATAL_ERROR "Studio Host requires ENABLE_FRONTEND_API=ON and ENABLE_QT=ON")
endif()

find_package(obs-frontend-api REQUIRED)
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE OBS::obs-frontend-api)

find_package(Qt6 REQUIRED COMPONENTS Widgets Core)
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE Qt6::Core Qt6::Widgets)
target_compile_options(
  ${CMAKE_PROJECT_NAME}
  PRIVATE $<$<C_COMPILER_ID:Clang,AppleClang>:-Wno-quoted-include-in-framework-header -Wno-comma>
)
set_target_properties(
  ${CMAKE_PROJECT_NAME}
  PROPERTIES AUTOMOC ON AUTOUIC ON AUTORCC ON
)

# The bundled Node.js runtime is fetched into data/node by build-aux/fetch-node before configuring.
if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/data/node")
  message(WARNING "data/node is missing: run build-aux/fetch-node first to bundle the Node.js runtime")
endif()

target_sources(
  ${CMAKE_PROJECT_NAME}
  PRIVATE
    src/plugin-main.cpp
    src/studio-controller.cpp
    src/studio-controller.hpp
    src/server-process.cpp
    src/server-process.hpp
    src/obs-feed.cpp
    src/obs-feed.hpp
    src/guest-mixer.cpp
    src/guest-mixer.hpp
    src/studio-sources.cpp
    src/studio-sources.hpp
    src/studio-scenes.cpp
    src/studio-scenes.hpp
    src/studio-dock.cpp
    src/studio-dock.hpp
    src/studio-hotkeys.cpp
    src/studio-hotkeys.hpp
)

set_target_properties_plugin(${CMAKE_PROJECT_NAME} PROPERTIES OUTPUT_NAME ${_name})
