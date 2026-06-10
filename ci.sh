#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"

# ------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------

declare -a CHECK_NAMES=()
declare -a CHECK_DIRS=()
declare -a CHECK_CMDS=()

add_check() {
    local name="$1"
    local dir="$2"
    local cmd="$3"

    CHECK_NAMES+=("$name")
    CHECK_DIRS+=("$ROOT/$dir")
    CHECK_CMDS+=("$cmd")
}

configure_checks() {
    add_check "deveye-types" "../DevEye-Types" "npm run ci"
    add_check "deveye-server" "." "npm run ci"
    add_check "deveye-client" "client" "npm run ci"
}

SIGNAL_PATTERN='warn(ing)?|deprecated|deprecation|error|err!|fail(ed|ure)?|fatal|exception|traceback|panic'
FALSE_POSITIVE_PATTERN='(^|[^[:alnum:]])(0|no)[[:space:]]+(errors?|warnings?)([^[:alnum:]]|$)'

SPINNER_FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")

# ------------------------------------------------------------------------------
# Runtime state
# ------------------------------------------------------------------------------

declare -a PIDS=()
declare -a EXIT_CODES=()
declare -a DURATIONS=()
declare -a HAS_WARNINGS=()
declare -a START_TIMES=()

BOLD=""
DIM=""
RESET=""
RED=""
GREEN=""
YELLOW=""
CYAN=""

LIVE_UI=0
LIVE_RENDERED=0
TABLE_LINES=0

# ------------------------------------------------------------------------------
# Generic helpers
# ------------------------------------------------------------------------------

log_file_for() {
    local index="$1"

    printf "%s/%s.log" "$TMP_DIR" "$index"
}

status_file_for() {
    local index="$1"

    printf "%s/%s.status" "$TMP_DIR" "$index"
}

setup_colors() {
    if [[ -t 1 && -z "${NO_COLOR:-}" ]] \
        && command -v tput >/dev/null 2>&1 \
        && tput colors >/dev/null 2>&1; then
        BOLD="$(tput bold)"
        DIM="$(tput dim)"
        RESET="$(tput sgr0)"
        RED="$(tput setaf 1)"
        GREEN="$(tput setaf 2)"
        YELLOW="$(tput setaf 3)"
        CYAN="$(tput setaf 6)"
    fi
}

format_duration() {
    local seconds="$1"

    if (( seconds < 60 )); then
        printf "%ss" "$seconds"
    else
        printf "%dm%02ds" "$((seconds / 60))" "$((seconds % 60))"
    fi
}

extract_signal() {
    local log_file="$1"

    grep -Eai "$SIGNAL_PATTERN" "$log_file" \
        | grep -Eavi "$FALSE_POSITIVE_PATTERN" \
        || true
}

has_warnings() {
    local log_file="$1"

    grep -Eai 'warn(ing)?|deprecated|deprecation' "$log_file" \
        | grep -Eavi "$FALSE_POSITIVE_PATTERN" \
        >/dev/null
}

# ------------------------------------------------------------------------------
# Cleanup
# ------------------------------------------------------------------------------

cleanup() {
    local pid

    if (( LIVE_UI )); then
        printf "\033[?25h"
    fi

    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done

    rm -rf "$TMP_DIR"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ------------------------------------------------------------------------------
# Checks
# ------------------------------------------------------------------------------

run_check() {
    local index="$1"

    local name="${CHECK_NAMES[$index]}"
    local dir="${CHECK_DIRS[$index]}"
    local cmd="${CHECK_CMDS[$index]}"
    local log_file
    local status_file
    local start
    local end
    local exit_code

    log_file="$(log_file_for "$index")"
    status_file="$(status_file_for "$index")"

    start="$(date +%s)"

    if [[ ! -d "$dir" ]]; then
        printf "error: directory does not exist: %s\n" "$dir" >"$log_file"
        printf "1\n0\n" >"$status_file"
        return
    fi

    printf "Running %s in %s\nCommand: %s\n\n" "$name" "$dir" "$cmd" >"$log_file"

    (
        cd "$dir" && bash -lc "$cmd"
    ) >>"$log_file" 2>&1

    exit_code=$?
    end="$(date +%s)"

    printf "%s\n%s\n" "$exit_code" "$((end - start))" >"$status_file"
}

start_checks() {
    local index

    for (( index = 0; index < ${#CHECK_NAMES[@]}; index++ )); do
        START_TIMES[$index]="$(date +%s)"
        run_check "$index" &
        PIDS[$index]=$!
    done
}

checks_pending() {
    local index

    for (( index = 0; index < ${#CHECK_NAMES[@]}; index++ )); do
        if [[ ! -s "$(status_file_for "$index")" ]]; then
            return 0
        fi
    done

    return 1
}

wait_for_checks() {
    local index

    for (( index = 0; index < ${#CHECK_NAMES[@]}; index++ )); do
        wait "${PIDS[$index]}" || true
    done

    PIDS=()
}

read_results() {
    local index
    local status_file
    local log_file
    local exit_code
    local duration

    for (( index = 0; index < ${#CHECK_NAMES[@]}; index++ )); do
        status_file="$(status_file_for "$index")"
        log_file="$(log_file_for "$index")"

        if [[ -s "$status_file" ]]; then
            {
                IFS= read -r exit_code || exit_code=1
                IFS= read -r duration || duration=0
            } <"$status_file"
        else
            exit_code=1
            duration=0
            printf "error: check process ended without writing a status file\n" >"$log_file"
        fi

        EXIT_CODES[$index]="$exit_code"
        DURATIONS[$index]="$duration"

        if has_warnings "$log_file"; then
            HAS_WARNINGS[$index]=1
        else
            HAS_WARNINGS[$index]=0
        fi
    done
}

# ------------------------------------------------------------------------------
# Rendering
# ------------------------------------------------------------------------------

status_for_check() {
    local exit_code="$1"
    local has_warnings="$2"

    if (( exit_code != 0 )); then
        printf "failed   ✗"
    elif (( has_warnings != 0 )); then
        printf "warning  ⚠"
    else
        printf "passed   ✓"
    fi
}

color_for_check() {
    local exit_code="$1"
    local has_warnings="$2"

    if (( exit_code != 0 )); then
        printf "%s" "$RED"
    elif (( has_warnings != 0 )); then
        printf "%s" "$YELLOW"
    else
        printf "%s" "$GREEN"
    fi
}

print_table() {
    local tick="$1"
    local final="${2:-0}"

    local now
    local index
    local name
    local status
    local color
    local duration
    local exit_code
    local has_warning
    local log_file
    local status_file
    local spinner

    now="$(date +%s)"

    printf "┌────────────────────┬────────────┬───────┐\n"
    printf "│ %-18s │ %-10s │ %-5s │\n" "DevEye CI" "Result" "Time"
    printf "├────────────────────┼────────────┼───────┤\n"

    for (( index = 0; index < ${#CHECK_NAMES[@]}; index++ )); do
        name="${CHECK_NAMES[$index]}"
        log_file="$(log_file_for "$index")"
        status_file="$(status_file_for "$index")"

        if (( final )); then
            exit_code="${EXIT_CODES[$index]}"
            duration="${DURATIONS[$index]}"
            has_warning="${HAS_WARNINGS[$index]}"

            status="$(status_for_check "$exit_code" "$has_warning")"
            color="$(color_for_check "$exit_code" "$has_warning")"

        elif [[ -s "$status_file" ]]; then
            {
                IFS= read -r exit_code || exit_code=1
                IFS= read -r duration || duration=0
            } <"$status_file"

            if has_warnings "$log_file"; then
                has_warning=1
            else
                has_warning=0
            fi

            status="$(status_for_check "$exit_code" "$has_warning")"
            color="$(color_for_check "$exit_code" "$has_warning")"

        else
            spinner="${SPINNER_FRAMES[$(((tick + index) % ${#SPINNER_FRAMES[@]}))]}"
            status="running  $spinner"
            color="$CYAN"
            duration="$((now - START_TIMES[index]))"
        fi

        printf "│ %-18s │ %s%-12s%s │ %-5s │\n" \
            "$name" \
            "$color" \
            "$status" \
            "$RESET" \
            "$(format_duration "$duration")"
    done

    printf "└────────────────────┴────────────┴───────┘\n"
}

render_live_table() {
    local tick="$1"
    local final="${2:-0}"

    if (( LIVE_RENDERED )); then
        printf "\033[%sA" "$TABLE_LINES"
    fi

    LIVE_RENDERED=1
    print_table "$tick" "$final"
}

monitor_checks() {
    local tick=0

    if (( LIVE_UI )); then
        printf "\033[?25l"
        render_live_table "$tick"
    fi

    while checks_pending; do
        sleep 0.1
        ((tick++))

        if (( LIVE_UI )); then
            render_live_table "$tick"
        fi
    done

    wait_for_checks
}

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------

count_failures() {
    local index
    local failures=0

    for (( index = 0; index < ${#CHECK_NAMES[@]}; index++ )); do
        if (( EXIT_CODES[index] != 0 )); then
            ((failures++))
        fi
    done

    printf "%s" "$failures"
}

count_warnings() {
    local index
    local warnings=0

    for (( index = 0; index < ${#CHECK_NAMES[@]}; index++ )); do
        if (( EXIT_CODES[index] == 0 && HAS_WARNINGS[index] != 0 )); then
            ((warnings++))
        fi
    done

    printf "%s" "$warnings"
}

print_outcome() {
    local failures
    local warnings

    failures="$(count_failures)"
    warnings="$(count_warnings)"

    if (( failures > 0 )); then
        printf "\n%sCI failed after all checks finished.%s\n" "$RED" "$RESET"
    elif (( warnings > 0 )); then
        printf "\n%sCI passed with warnings.%s\n" "$YELLOW" "$RESET"
    else
        printf "\n%sAll CI checks passed.%s\n" "$GREEN" "$RESET"
    fi
}

print_diagnostics() {
    local index
    local name
    local log_file
    local signal
    local printed=0

    for (( index = 0; index < ${#CHECK_NAMES[@]}; index++ )); do
        name="${CHECK_NAMES[$index]}"
        log_file="$(log_file_for "$index")"

        if (( EXIT_CODES[index] == 0 && HAS_WARNINGS[index] == 0 )); then
            continue
        fi

        if (( printed == 0 )); then
            printf "\n%sDiagnostics%s\n" "$BOLD" "$RESET"
            printed=1
        fi

        if (( EXIT_CODES[index] != 0 )); then
            printf "\n%s%s%s %s(failed, exit %s)%s\n" \
                "$BOLD" \
                "$name" \
                "$RESET" \
                "$RED" \
                "${EXIT_CODES[$index]}" \
                "$RESET"
        else
            printf "\n%s%s%s %s(warnings)%s\n" \
                "$BOLD" \
                "$name" \
                "$RESET" \
                "$YELLOW" \
                "$RESET"
        fi

        printf "────────────────────────────────────────\n"

        signal="$(extract_signal "$log_file")"

        if [[ -n "$signal" ]]; then
            printf "%s\n" "$signal"
        elif [[ -s "$log_file" ]]; then
            tail -n 80 "$log_file"
        else
            printf "No output captured.\n"
        fi
    done
}

# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------

main() {
    local failures

    configure_checks

    TABLE_LINES=$((${#CHECK_NAMES[@]} + 4))

    setup_colors

    if [[ -t 1 ]]; then
        LIVE_UI=1
    fi

    start_checks
    monitor_checks
    read_results

    if (( LIVE_UI )); then
        render_live_table 0 1
    else
        print_table 0 1
    fi

    print_outcome
    print_diagnostics

    failures="$(count_failures)"

    if (( failures > 0 )); then
        exit 1
    fi
}

main "$@"
