/**
 * Position-Based Parser
 * 
 * Parses PDF tables using word position data for accurate column detection.
 * Detects table headers, uses gap analysis to find table boundaries,
 * and groups rows using the date column as delimiter to handle multi-line descriptions.
 * 
 * Key Features:
 * - Detects multiple tables per page and across pages
 * - Uses line gaps to find table boundaries
 * - Smart column assignment: structured columns first, then description column
 * - Handles large gaps in descriptions by treating description as catch-all column
 * - Groups multi-line descriptions by detecting date column entries
 * 
 * Column Assignment Strategy:
 * The parser uses a two-pass approach to handle variable spacing in descriptions:
 * 1. First pass: Assign words to ALL non-description columns (date, amount, balance,
 *    transaction ID, reference number, check number, etc.) based on X-coordinate
 * 2. Second pass: Assign ALL remaining words to the description column as catch-all
 * 
 * This prevents large gaps in descriptions from causing words to be misassigned
 * to other columns. For example, "UPIAR/204845513259/DR/Latheef /CNRB/0749101056362@"
 * will be kept together even if there are large spaces between parts, while still
 * properly identifying transaction IDs, amounts, and other structured fields.
 */

import { parseAmount, cleanDescription, createResult, DATE_PATTERNS, END_OF_TABLE_PATTERNS } from './base-parser.js';

// Header pattern keywords for table detection
const HEADER_PATTERNS = {
    dateKeywords: ['date', 'trans date', 'tran date', 'transaction date', 'posted', 'post date', 'value date'],
    descKeywords: ['description', 'details', 'transaction details', 'merchant', 'payee', 'transaction', 'remarks', 'particulars', 'narration', 'reference'],
    amountKeywords: ['amount', 'deposit', 'withdrawal', 'credit', 'debit', 'balance', 'deposits', 'withdrawals', 'dr', 'cr', 'money out', 'money in', 'paid out', 'paid in', 'in', 'out'],
    
    // Strong exclusion patterns - lines containing these are NEVER transaction headers
    exclusionPatterns: [
        'payment due date',
        'minimum payment',
        'past due',
        'brought forward',
        'carried forward'
    ],
    // Soft exclusion patterns - only exclude if the line has fewer than minTotalMatches header keywords
    // (e.g. "Closing Balance" is a valid column header alongside Date, Description, Amount)
    softExclusionPatterns: [
        'new balance',
        'opening balance',
        'closing balance',
        'statement',
        'account number'
    ],
    
    // Minimum matches required to identify as table header
    minDateMatches: 1,
    minDescMatches: 0,  // Some tables might not have explicit description header
    minAmountMatches: 1,
    minTotalMatches: 3  // Total keywords needed to confirm table header (increased for robustness)
};

// Words to skip when they appear alone in a cell (noise)
const NOISE_WORDS = ['page', 'of', 'continued'];

// ─── Position Parser Configuration ──────────────────────────────────────────
// Centralized thresholds and constants for tuning. Adjust these values to change
// how the position parser detects tables, groups words, and assigns columns.
const POSITION_CONFIG = {
    // Word filtering thresholds
    MIN_WORD_HEIGHT: 2,           // Min word height in px (filters PDF layout artifacts; real text >= 3.0)
    MIN_FONT_SIZE: 5,             // Min font size in pt when height check fails (fine print is 6-7pt)
    HEIGHT_ISSUE_RATIO: 0.5,      // If >50% of words have small heights, disable height filtering

    // Line grouping
    Y_THRESHOLD: 5,               // Max Y-difference (px) to consider words on the same line

    // Line spacing / gap detection
    DEFAULT_LINE_SPACING: 15,     // Default median spacing when fewer than 2 lines
    MAX_REASONABLE_SPACING: 100,  // Ignore spacings larger than this for median calculation
    GAP_MULTIPLIER: 2.5,          // Gap > (median * multiplier) = table boundary

    // Header word merging
    MERGE_THRESHOLD_RATIO: 0.5,   // Merge header words if gap < (avgHeight * ratio)

    // Hidden column detection (vertical alignment analysis)
    MIN_ROW_FREQUENCY: 0.9,       // Clusters must appear in ≥90% of rows to be valid
    MIN_SEPARATION_FACTOR: 4,     // Clusters must be separated by ≥ (threshold * factor) to split
    ALIGNMENT_SAMPLE_SIZE: 10,    // Number of data rows to sample for alignment analysis
    FONT_SIZE_THRESHOLD_RATIO: 0.5, // Grouping tolerance = avgFontSize * ratio

    // Strict boundary padding
    STRICT_BOUNDARY_PADDING: 10   // Extra px added to strict headerXMin/headerXMax to catch
                                  // data words slightly wider than narrow header words (e.g.
                                  // "24 Aug 2023" (46px) under a 17px-wide "Date" header)
};

// Shorthand aliases for backward compat (referenced in flattenWords)
const MIN_WORD_HEIGHT = POSITION_CONFIG.MIN_WORD_HEIGHT;
const MIN_FONT_SIZE = POSITION_CONFIG.MIN_FONT_SIZE;

/**
 * Detect vertical alignment patterns in data rows to identify hidden column boundaries
 * 
 * When PDFs combine multiple columns into one text element (e.g., "12/20 67547518077131000222864"),
 * we can detect separate columns by finding consistent X positions across multiple rows.
 * 
 * Uses per-row analysis: clusters must appear in 90%+ of rows to be considered valid.
 * Only analyzes DATE and AMOUNT columns to avoid false positives.
 * 
 * @param {Array} dataLines - Array of line objects with words
 * @param {Array} columns - Initial column definitions from header
 * @param {number} sampleSize - Number of rows to analyze (default 10)
 * @returns {Array} Refined column definitions with hidden columns split
 */
function detectVerticalAlignmentPatterns(dataLines, columns, sampleSize = POSITION_CONFIG.ALIGNMENT_SAMPLE_SIZE) {
    if (!columns || columns.length === 0) return columns;
    if (!dataLines || dataLines.length === 0) return columns;
    
    const refinedColumns = [];
    
    // Determine column types - ONLY analyze DATE and AMOUNT columns
    const colTypes = determineColumnTypes(columns);
    
    for (let colIdx = 0; colIdx < columns.length; colIdx++) {
        const column = columns[colIdx];
        
        // ONLY analyze DATE and AMOUNT columns - skip description, balance, and all others
        const isDateCol = colIdx === colTypes.dateCol;
        const isAmountCol = colTypes.amountCols.includes(colIdx);
        
        if (!isDateCol && !isAmountCol) {
            refinedColumns.push({
                ...column,
                index: refinedColumns.length
            });
            continue;
        }
        
        // Collect X start positions PER ROW for per-row consistency checking
        const sampleRows = dataLines.slice(0, Math.min(sampleSize, dataLines.length));
        const rowXPositions = []; // Array of arrays: each inner array is X positions for one row
        let totalFontSize = 0;
        let fontSizeCount = 0;
        
        for (const line of sampleRows) {
            // Find words that fall within this column's STRICT boundaries (using headerXMin/Max)
            const wordsInColumn = [];
            for (const word of line.words) {
                const wordCenter = word.x + word.width / 2;
                
                // STRICT boundary check: use original header boundaries, not expanded midpoints
                if (wordCenter >= column.headerXMin && wordCenter <= column.headerXMax) {
                    wordsInColumn.push(word);
                    totalFontSize += word.fontSize;
                    fontSizeCount++;
                }
            }
            
            // Collect unique X start positions for this row
            const rowXs = wordsInColumn.map(w => w.x);
            if (rowXs.length > 0) {
                rowXPositions.push(rowXs);
            }
        }
        
        if (rowXPositions.length === 0) {
            refinedColumns.push({
                ...column,
                index: refinedColumns.length
            });
            continue;
        }
        
        // Calculate average font size for relative threshold
        const avgFontSize = fontSizeCount > 0 ? totalFontSize / fontSizeCount : 8;
        const threshold = avgFontSize * POSITION_CONFIG.FONT_SIZE_THRESHOLD_RATIO;
        
        // Flatten all positions and cluster them
        const allXPositions = rowXPositions.flat();
        const clusters = clusterPositions(allXPositions, threshold);
        
        // For each cluster, count in HOW MANY ROWS it appears
        const clusterRowCounts = clusters.map(cluster => {
            let rowsWithCluster = 0;
            
            for (const rowXs of rowXPositions) {
                // Check if any X in this row falls within this cluster
                const hasClusterInRow = rowXs.some(x => 
                    Math.abs(x - cluster.center) <= threshold
                );
                
                if (hasClusterInRow) {
                    rowsWithCluster++;
                }
            }
            
            return {
                ...cluster,
                rowCount: rowsWithCluster,
                rowFrequency: rowsWithCluster / rowXPositions.length
            };
        });
        
        // Filter clusters: must appear in enough rows to be considered valid
        const consistentClusters = clusterRowCounts.filter(c => c.rowFrequency >= POSITION_CONFIG.MIN_ROW_FREQUENCY);
        
        // Additional validation: clusters must be significantly separated
        let wellSeparatedClusters = [];
        if (consistentClusters.length > 1) {
            consistentClusters.sort((a, b) => a.center - b.center);
            
            // Check that clusters are separated by at least N times the threshold
            const minSeparation = threshold * POSITION_CONFIG.MIN_SEPARATION_FACTOR;
            wellSeparatedClusters.push(consistentClusters[0]);
            
            for (let i = 1; i < consistentClusters.length; i++) {
                const gap = consistentClusters[i].center - consistentClusters[i-1].center;
                if (gap >= minSeparation) {
                    wellSeparatedClusters.push(consistentClusters[i]);
                }
            }
        }
        
        // Only split if we have multiple well-separated, highly-consistent clusters
        if (wellSeparatedClusters.length > 1) {
            // Clusters are already sorted from previous step
            
            // Create sub-columns based on detected boundaries
            for (let i = 0; i < wellSeparatedClusters.length; i++) {
                const subColXMin = i === 0 ? column.xMin : wellSeparatedClusters[i].center;
                const subColXMax = i < wellSeparatedClusters.length - 1 
                    ? wellSeparatedClusters[i + 1].center 
                    : column.xMax;
                
                // Split header text proportionally based on X positions
                const headerText = splitHeaderTextByPosition(
                    column.name, 
                    column.xMin, 
                    column.xMax,
                    subColXMin,
                    subColXMax
                );
                
                refinedColumns.push({
                    name: headerText,
                    xMin: subColXMin,
                    xMax: subColXMax,
                    headerXMin: subColXMin,
                    headerXMax: subColXMax,
                    index: refinedColumns.length
                });
            }
        } else {
            // No split needed
            refinedColumns.push({
                ...column,
                index: refinedColumns.length
            });
        }
    }
    
    return refinedColumns;
}

/**
 * Cluster positions into groups based on proximity
 * 
 * @param {Array} positions - Array of X positions
 * @param {number} threshold - Maximum distance to consider same cluster
 * @returns {Array} Array of cluster objects with { center, count, positions }
 */
function clusterPositions(positions, threshold) {
    if (positions.length === 0) return [];
    
    // Sort positions
    const sorted = [...positions].sort((a, b) => a - b);
    
    const clusters = [];
    let currentCluster = { positions: [sorted[0]], sum: sorted[0], count: 1 };
    
    for (let i = 1; i < sorted.length; i++) {
        const pos = sorted[i];
        const currentCenter = currentCluster.sum / currentCluster.count;
        
        if (Math.abs(pos - currentCenter) <= threshold) {
            // Add to current cluster
            currentCluster.positions.push(pos);
            currentCluster.sum += pos;
            currentCluster.count++;
        } else {
            // Start new cluster
            clusters.push({
                center: currentCluster.sum / currentCluster.count,
                count: currentCluster.count,
                positions: currentCluster.positions
            });
            currentCluster = { positions: [pos], sum: pos, count: 1 };
        }
    }
    
    // Don't forget last cluster
    clusters.push({
        center: currentCluster.sum / currentCluster.count,
        count: currentCluster.count,
        positions: currentCluster.positions
    });
    
    return clusters;
}

/**
 * Split header text based on sub-column position, respecting word boundaries
 * 
 * @param {string} headerText - Original combined header text
 * @param {number} colXMin - Column start X
 * @param {number} colXMax - Column end X
 * @param {number} subColXMin - Sub-column start X
 * @param {number} subColXMax - Sub-column end X
 * @returns {string} Extracted portion of header text
 */
function splitHeaderTextByPosition(headerText, colXMin, colXMax, subColXMin, subColXMax) {
    const colWidth = colXMax - colXMin;
    if (colWidth === 0) return headerText;
    
    // Calculate what portion of the column this sub-column represents
    const startPortion = (subColXMin - colXMin) / colWidth;
    const endPortion = (subColXMax - colXMin) / colWidth;
    
    // Split by words and calculate their approximate positions
    const words = headerText.split(/\s+/);
    if (words.length === 1) {
        // Single word, just return it
        return headerText;
    }
    
    // Calculate approximate X position for each word
    const avgCharWidth = colWidth / headerText.length;
    let currentPos = 0;
    const wordPositions = [];
    
    for (const word of words) {
        const wordStart = currentPos;
        const wordEnd = currentPos + word.length;
        const wordCenter = (wordStart + wordEnd) / 2;
        const wordCenterPortion = wordCenter / headerText.length;
        
        wordPositions.push({
            word: word,
            startPortion: wordStart / headerText.length,
            endPortion: wordEnd / headerText.length,
            centerPortion: wordCenterPortion
        });
        
        currentPos = wordEnd + 1; // +1 for space
    }
    
    // Find words that belong to this sub-column based on their center position
    const selectedWords = wordPositions.filter(wp => 
        wp.centerPortion >= startPortion && wp.centerPortion < endPortion
    );
    
    if (selectedWords.length > 0) {
        return selectedWords.map(w => w.word).join(' ');
    }
    
    // Fallback: proportional character split
    const textLength = headerText.length;
    const startIdx = Math.floor(startPortion * textLength);
    const endIdx = Math.ceil(endPortion * textLength);
    const extracted = headerText.substring(startIdx, endIdx).trim();
    
    return extracted || headerText;
}

/**
 * Split words that span multiple columns based on column boundaries
 * 
 * When a word's bounding box overlaps multiple column boundaries,
 * split it into separate word objects for each column using whitespace
 * as the natural split point when available.
 * 
 * @param {Array} words - Array of word objects
 * @param {Array} columns - Column definitions with headerXMin, headerXMax
 * @returns {Array} Array of word objects with spanning words split
 */
function splitWordsByColumnBoundaries(words, columns) {
    const result = [];
    
    for (const word of words) {
        const wordStart = word.x;
        const wordEnd = word.x + word.width;
        
        // Find which columns this word overlaps with
        const overlappingCols = [];
        
        for (const col of columns) {
            const colStart = col.headerXMin;
            const colEnd = col.headerXMax;
            
            // Calculate overlap
            const overlapStart = Math.max(wordStart, colStart);
            const overlapEnd = Math.min(wordEnd, colEnd);
            const overlapWidth = overlapEnd - overlapStart;
            
            if (overlapWidth > 0) {
                overlappingCols.push({
                    col: col,
                    overlapStart: overlapStart,
                    overlapEnd: overlapEnd,
                    overlapWidth: overlapWidth
                });
            }
        }
        
        // If word spans multiple columns, try to split it intelligently
        if (overlappingCols.length > 1) {
            // ONLY split words that contain whitespace
            // Words without whitespace that span columns are likely:
            // - Wide text that happens to cross boundaries (keep together)
            // - Wrapped continuation text (keep together)
            // - Not truly combined column data
            const hasWhitespace = /\s/.test(word.text);
            
            if (!hasWhitespace) {
                // No whitespace - don't split, keep word intact
                result.push(word);
            } else {
                // Has whitespace - try splitting by whitespace
                const parts = word.text.split(/\s+/);
                
                if (parts.length === overlappingCols.length) {
                    // Perfect match - split by whitespace
                    const avgCharWidth = word.width / word.text.length;
                    let currentX = word.x;
                    
                    for (let i = 0; i < parts.length; i++) {
                        const partText = parts[i];
                        const partWidth = partText.length * avgCharWidth;
                        
                        result.push({
                            text: partText,
                            x: currentX,
                            y: word.y,
                            width: partWidth,
                            height: word.height,
                            fontSize: word.fontSize,
                            page: word.page
                        });
                        
                        currentX += partWidth + avgCharWidth; // Add space width
                    }
                } else {
                    // Whitespace count doesn't match column count - keep word intact
                    // to avoid incorrect splitting
                    result.push(word);
                }
            }
        } else {
            // No split needed
            result.push(word);
        }
    }
    
    return result;
}

/**
 * Group words into lines based on Y coordinate proximity
 * 
 * @param {Array} words - Array of word objects with x, y, text, width, height, page
 * @param {number} yThreshold - Maximum Y difference to consider same line (default 5)
 * @returns {Array} Array of line objects sorted by page then Y coordinate
 */
function groupWordsIntoLines(words, yThreshold = POSITION_CONFIG.Y_THRESHOLD) {
    if (!words || words.length === 0) return [];
    
    // Sort words by page, then by Y (top to bottom), then by X (left to right)
    const sortedWords = [...words].sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        if (Math.abs(a.y - b.y) > yThreshold) return a.y - b.y;
        return a.x - b.x;
    });
    
    const lines = [];
    let currentLine = null;
    
    for (const word of sortedWords) {
        // Check if word belongs to current line
        if (currentLine && 
            currentLine.page === word.page && 
            Math.abs(currentLine.y - word.y) <= yThreshold) {
            // Add to current line
            currentLine.words.push(word);
            currentLine.minX = Math.min(currentLine.minX, word.x);
            currentLine.maxX = Math.max(currentLine.maxX, word.x + word.width);
        } else {
            // Start new line
            if (currentLine) {
                // Sort words in line by X before saving
                currentLine.words.sort((a, b) => a.x - b.x);
                lines.push(currentLine);
            }
            currentLine = {
                y: word.y,
                page: word.page,
                words: [word],
                minX: word.x,
                maxX: word.x + word.width
            };
        }
    }
    
    // Don't forget the last line
    if (currentLine) {
        currentLine.words.sort((a, b) => a.x - b.x);
        lines.push(currentLine);
    }
    
    return lines;
}

/**
 * Check if a line matches table header patterns
 * 
 * @param {Object} line - Line object with words array
 * @returns {Object|null} Match result with column info, or null if not a header
 */
function matchesHeaderPattern(line) {
    if (!line || !line.words || line.words.length < 2) return null;
    
    // Combine all words in line to check for multi-word headers
    const lineText = line.words.map(w => w.text.toLowerCase()).join(' ');
    const individualWords = line.words.map(w => w.text.toLowerCase());
    
    // Check strong exclusion patterns first - always reject
    for (const exclusionPattern of HEADER_PATTERNS.exclusionPatterns) {
        if (lineText.includes(exclusionPattern)) {
            return null;
        }
    }

    // Check soft exclusion patterns — these may appear as column headers
    // (e.g. "Closing Balance" alongside Date, Narration, Withdrawal)
    const hasSoftExclusion = HEADER_PATTERNS.softExclusionPatterns.some(p => lineText.includes(p));

    let dateMatches = 0;
    let descMatches = 0;
    let amountMatches = 0;

    // Check for keyword matches
    for (const keyword of HEADER_PATTERNS.dateKeywords) {
        if (lineText.includes(keyword) || individualWords.some(w => w === keyword)) {
            dateMatches++;
        }
    }

    for (const keyword of HEADER_PATTERNS.descKeywords) {
        if (lineText.includes(keyword) || individualWords.some(w => w === keyword)) {
            descMatches++;
        }
    }

    for (const keyword of HEADER_PATTERNS.amountKeywords) {
        if (lineText.includes(keyword) || individualWords.some(w => w === keyword)) {
            amountMatches++;
        }
    }

    const totalMatches = dateMatches + descMatches + amountMatches;

    // If soft exclusion matched, require MORE keyword evidence to override
    // (at least 4 total keyword matches to prove this is a genuine header row)
    if (hasSoftExclusion && totalMatches < 4) {
        return null;
    }

    // Check if we have enough matches
    if (dateMatches >= HEADER_PATTERNS.minDateMatches &&
        amountMatches >= HEADER_PATTERNS.minAmountMatches &&
        totalMatches >= HEADER_PATTERNS.minTotalMatches) {
        return {
            dateMatches,
            descMatches,
            amountMatches,
            totalMatches,
            lineText
        };
    }
    
    return null;
}

/**
 * Find all table headers in the document
 * 
 * @param {Array} lines - Array of line objects
 * @returns {Array} Array of header objects with line reference and index
 */
function findTableHeaders(lines) {
    const headers = [];
    
    for (let i = 0; i < lines.length; i++) {
        const match = matchesHeaderPattern(lines[i]);
        if (match) {
            headers.push({
                lineIndex: i,
                line: lines[i],
                page: lines[i].page,
                y: lines[i].y,
                match
            });
        }
    }
    
    return headers;
}

/**
 * Calculate median line spacing for gap detection
 * 
 * @param {Array} lines - Array of line objects (same page)
 * @returns {number} Median spacing between lines
 */
function calculateMedianLineSpacing(lines) {
    if (lines.length < 2) return POSITION_CONFIG.DEFAULT_LINE_SPACING;
    
    const spacings = [];
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].page === lines[i-1].page) {
            const spacing = lines[i].y - lines[i-1].y;
            if (spacing > 0 && spacing < POSITION_CONFIG.MAX_REASONABLE_SPACING) {
                spacings.push(spacing);
            }
        }
    }
    
    if (spacings.length === 0) return 15;
    
    spacings.sort((a, b) => a - b);
    const mid = Math.floor(spacings.length / 2);
    return spacings.length % 2 ? spacings[mid] : (spacings[mid - 1] + spacings[mid]) / 2;
}

/**
 * Find the bottom of a table using gap detection
 * 
 * @param {Array} lines - All lines in document
 * @param {number} headerIndex - Index of the header line
 * @param {number} gapMultiplier - How many times median spacing = big gap (default 2.5)
 * @returns {Object} Table bottom info with endIndex and endY
 */
function findTableBottom(lines, headerIndex, gapMultiplier = POSITION_CONFIG.GAP_MULTIPLIER) {
    const headerLine = lines[headerIndex];
    const headerPage = headerLine.page;

    // Get lines on same page after header
    const pageLines = lines.filter((l, i) => i > headerIndex && l.page === headerPage);

    if (pageLines.length === 0) {
        return { endIndex: headerIndex, endY: headerLine.y };
    }

    // Calculate median spacing for this section
    const medianSpacing = calculateMedianLineSpacing([headerLine, ...pageLines]);
    let gapThreshold = medianSpacing * gapMultiplier;

    // If the spacing distribution is bimodal (e.g. 7px within transactions, 29px between
    // transaction groups), use the larger cluster as the baseline instead of the median.
    // This prevents the algorithm from cutting the table at every transaction boundary.
    const spacings = [];
    let prevY = headerLine.y;
    for (const line of pageLines) {
        const s = line.y - prevY;
        if (s > 0 && s < POSITION_CONFIG.MAX_REASONABLE_SPACING) spacings.push(s);
        prevY = line.y;
    }
    if (spacings.length >= 4) {
        spacings.sort((a, b) => a - b);
        // Check if there are two distinct spacing clusters
        const q75 = spacings[Math.floor(spacings.length * 0.75)];
        const q25 = spacings[Math.floor(spacings.length * 0.25)];
        if (q75 > q25 * 2.5) {
            // Bimodal distribution — use q75 as the "normal" spacing
            gapThreshold = q75 * gapMultiplier;
        }
    }

    let lastValidIndex = headerIndex;
    let lastY = headerLine.y;
    let isFirstGap = true;

    for (let i = 0; i < pageLines.length; i++) {
        const lineIndex = lines.indexOf(pageLines[i]);
        const line = pageLines[i];
        const gap = line.y - lastY;

        // Check for large gap
        if (gap > gapThreshold) {
            // For the first gap after header, check if nearby lines have dates
            // (header-to-data visual separator is common in many PDFs)
            if (isFirstGap) {
                const nextFewLines = pageLines.slice(i, i + 5);
                const hasDateNearby = nextFewLines.some(l => {
                    const text = l.words.map(w => w.text).join(' ');
                    return DATE_PATTERNS.some(p => p.test(text.replace(/\s+/g, '')));
                });
                if (hasDateNearby) {
                    // Skip this gap — it's just a header separator
                    isFirstGap = false;
                    lastValidIndex = lineIndex;
                    lastY = line.y;
                    continue;
                }
            }
            break;
        }
        isFirstGap = false;

        // Check for end markers in line text using shared generic patterns
        const lineText = line.words.map(w => w.text).join(' ');

        if (END_OF_TABLE_PATTERNS.some(pattern => pattern.test(lineText))) {
            // Stop before this line (don't include it)
            break;
        }

        // Check if this line is another header (next table)
        if (matchesHeaderPattern(line)) {
            break;
        }

        lastValidIndex = lineIndex;
        lastY = line.y;
    }

    return { endIndex: lastValidIndex, endY: lastY };
}

/**
 * Split words that contain multiple column names separated by spaces
 * 
 * PDFMiner sometimes extracts "AMOUNT               BALANCE" as a single word.
 * This function splits such words into separate virtual words.
 * 
 * @param {Array} words - Array of word objects
 * @returns {Array} Array with split words
 */
function splitMultiColumnWords(words) {
    const result = [];
    
    for (const word of words) {
        // Check if word contains significant internal whitespace (2+ spaces)
        if (word.text.includes('  ')) {
            // Split on 2+ spaces
            const parts = word.text.split(/\s{2,}/);
            
            if (parts.length > 1 && parts.every(p => p.trim())) {
                // Calculate approximate position for each part
                const charWidth = word.width / word.text.length;
                let currentX = word.x;
                
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i].trim();
                    if (!part) continue;
                    
                    const partWidth = part.length * charWidth;
                    result.push({
                        text: part,
                        x: currentX,
                        y: word.y,
                        width: partWidth,
                        height: word.height,
                        page: word.page
                    });
                    
                    // Move to next position (include original spacing)
                    // Use indexOf instead of RegExp to avoid crashes on special chars (*, +, etc.)
                    const idx = word.text.indexOf(part, Math.round((currentX - word.x) / charWidth));
                    const afterPart = idx >= 0 ? idx + part.length : currentX - word.x + part.length;
                    // Find how far to advance including trailing whitespace
                    let endPos = afterPart;
                    while (endPos < word.text.length && word.text[endPos] === ' ') endPos++;
                    currentX = word.x + endPos * charWidth;
                }
            } else {
                result.push(word);
            }
        } else {
            result.push(word);
        }
    }
    
    return result;
}

/**
 * Build column definitions from a header line using relative gap analysis
 * 
 * Uses median gap analysis to adaptively determine column boundaries.
 * Words with gaps significantly smaller than the median are merged into
 * multi-word column headers; larger gaps indicate column boundaries.
 * 
 * @param {Object} headerLine - Line object representing the table header
 * @returns {Array} Array of column definitions with name, xMin, xMax, index
 */
function buildColumnsFromHeader(headerLine) {
    if (!headerLine || !headerLine.words || headerLine.words.length === 0) {
        return [];
    }
    
    const columns = [];
    
    // Preprocess: Split words that contain multiple column names
    const splitWords = splitMultiColumnWords(headerLine.words);

    // Filter out noise words (e.g., "continued", "page", "of") and empty/whitespace-only
    // words that are column separator artifacts from PDF rendering.
    // Also filter single-char non-alphanumeric words (invisible separator chars).
    const words = splitWords.filter(w => {
        const t = w.text.trim();
        if (t.length === 0) return false;
        if (NOISE_WORDS.includes(t.toLowerCase())) return false;
        // Single-char words with no letters or digits are separator artifacts
        if (t.length <= 1 && !/[a-zA-Z0-9]/.test(t)) return false;
        return true;
    });
    
    // If only one word, check if it needs splitting
    if (words.length === 1) {
        // Even single word might contain multiple columns
        // This handles the fallback case
        return [{
            name: words[0].text,
            xMin: 0,
            xMax: 9999,
            index: 0
        }];
    }
    
    // Calculate average height for threshold calculation
    const avgHeight = words.reduce((sum, w) => sum + w.height, 0) / words.length;
    
    // Determine merge threshold:
    // PDFMiner already combines closely-spaced characters into words,
    // so remaining gaps between extracted words are typically column separators.
    // 
    // Use a conservative threshold based on typical space width in PDF.
    // A space character is typically 0.25-0.33 of font height.
    // Only merge words if gap is smaller than half a character width (~7px for 14pt font).
    // This ensures columns like "Amount (Rs.)" and "Balance (Rs.)" stay separate
    // while still allowing truly adjacent words to merge.
    const mergeThreshold = avgHeight * POSITION_CONFIG.MERGE_THRESHOLD_RATIO;
    
    // Step 5: Group words into columns based on threshold
    let currentColumn = {
        words: [words[0]],
        xMin: words[0].x,
        xMax: words[0].x + words[0].width
    };
    
    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const prevWord = words[i - 1];
        const gap = word.x - (prevWord.x + prevWord.width);
        
        // Merge if gap is smaller than threshold (intra-column spacing)
        if (gap < mergeThreshold) {
            // Same column - words form multi-word header
            currentColumn.words.push(word);
            currentColumn.xMax = word.x + word.width;
        } else {
            // New column - gap is significant enough to be a column boundary
            columns.push({
                name: currentColumn.words.map(w => w.text).join(' '),
                xMin: currentColumn.xMin,
                xMax: currentColumn.xMax,
                index: columns.length
            });
            
            currentColumn = {
                words: [word],
                xMin: word.x,
                xMax: word.x + word.width
            };
        }
    }
    
    // Don't forget the last column
    columns.push({
        name: currentColumn.words.map(w => w.text).join(' '),
        xMin: currentColumn.xMin,
        xMax: currentColumn.xMax,
        index: columns.length
    });

    // Post-process: merge adjacent columns whose combined text (spaces removed)
    // matches a known header keyword. Handles OCR/extraction artifacts like
    // "W ITHDRAWAL" split into two columns "W" + "ITHDRAWAL".
    const allKeywords = [
        ...HEADER_PATTERNS.dateKeywords,
        ...HEADER_PATTERNS.descKeywords,
        ...HEADER_PATTERNS.amountKeywords
    ];
    let mergedAny = true;
    while (mergedAny) {
        mergedAny = false;
        for (let i = 0; i < columns.length - 1; i++) {
            const combinedName = (columns[i].name + columns[i + 1].name)
                .replace(/\s+/g, '').toLowerCase();
            if (allKeywords.some(kw => combinedName === kw.replace(/\s+/g, ''))) {
                // Merge columns[i] and columns[i+1]
                columns[i] = {
                    name: columns[i].name + ' ' + columns[i + 1].name,
                    xMin: columns[i].xMin,
                    xMax: columns[i + 1].xMax,
                    index: columns[i].index
                };
                columns.splice(i + 1, 1);
                // Re-index remaining columns
                for (let j = i + 1; j < columns.length; j++) {
                    columns[j].index = j;
                }
                mergedAny = true;
                break;
            }
        }
    }

    // Store original header boundaries before expansion
    // These represent the actual X to X+width of header words
    for (let i = 0; i < columns.length; i++) {
        columns[i].headerXMin = columns[i].xMin;
        columns[i].headerXMax = columns[i].xMax;
    }
    
    // Expand column boundaries to cover gaps between columns
    // These expanded boundaries are used only for the description column
    for (let i = 0; i < columns.length; i++) {
        if (i > 0) {
            // Extend left boundary to midpoint with previous column
            const midpoint = (columns[i - 1].xMax + columns[i].xMin) / 2;
            columns[i].xMin = midpoint;
            columns[i - 1].xMax = midpoint;
        }
    }
    
    // Extend first column to page start and last column to page end
    if (columns.length > 0) {
        columns[0].xMin = 0;
        columns[columns.length - 1].xMax = 9999; // Effectively page width
    }
    
    return columns;
}

/**
 * Find which column a word belongs to based on its x position
 * 
 * Uses strict header boundary matching: word center must be within the
 * original header word boundaries (headerXMin to headerXMax).
 * 
 * @param {Object} word - Word object with x, width
 * @param {Array} columns - Array of column definitions
 * @param {boolean} useStrictBounds - If true, use original header boundaries
 * @returns {number} Column index, or -1 if not found
 */
function findColumnForWord(word, columns, useStrictBounds = true) {
    // Use the center point of the word
    const wordCenter = word.x + word.width / 2;
    
    if (useStrictBounds) {
        // Use original header boundaries with small padding.
        // Narrow header words (e.g. "Date" at 16px) can be narrower than
        // their data (e.g. "07/03/23" at 36px). A small padding ensures
        // data whose center falls just outside the header text still matches.
        const pad = POSITION_CONFIG.STRICT_BOUNDARY_PADDING;
        for (const col of columns) {
            if (wordCenter >= (col.headerXMin - pad) && wordCenter <= (col.headerXMax + pad)) {
                return col.index;
            }
        }
        // If not found with strict bounds, return -1 (unassigned)
        return -1;
    } else {
        // Use expanded boundaries (fallback for description column)
        for (const col of columns) {
            if (wordCenter >= col.xMin && wordCenter <= col.xMax) {
                return col.index;
            }
        }
        
        // If not found, find closest column
        let closestCol = 0;
        let closestDist = Infinity;
        
        for (const col of columns) {
            const colCenter = (col.xMin + col.xMax) / 2;
            const dist = Math.abs(wordCenter - colCenter);
            if (dist < closestDist) {
                closestDist = dist;
                closestCol = col.index;
            }
        }
        
        return closestCol;
    }
}

/**
 * Assign words to columns for data lines
 * 
 * Strict boundary strategy: Words are assigned to columns only if their center
 * point lies within the original header word boundaries (X to X+width).
 * Exception: Description column acts as catch-all for remaining words.
 * 
 * This prevents words from being incorrectly assigned when they fall in gaps
 * between header words, improving accuracy for structured columns.
 * 
 * @param {Array} dataLines - Array of line objects between header and table bottom
 * @param {Array} columns - Array of column definitions
 * @returns {Array} 2D array: result[lineIndex][colIndex] = [words]
 */
function assignWordsToColumns(dataLines, columns) {
    const result = [];
    
    // Determine column types to identify which is the description column
    const colTypes = determineColumnTypes(columns);
    
    for (const line of dataLines) {
        const lineData = columns.map(() => []);
        const assignedWords = new Set(); // Track which words have been assigned
        
        // Step 1: Assign words to ALL non-description columns using STRICT boundaries
        // Word center must be within original header word boundaries (headerXMin to headerXMax)
        // Only the description column is processed last as the catch-all
        for (const word of line.words) {
            const colIndex = findColumnForWord(word, columns, true); // Use strict bounds
            
            // Assign to any column EXCEPT the description column
            if (colIndex >= 0 && colIndex < columns.length && colIndex !== colTypes.descCol) {
                lineData[colIndex].push(word);
                assignedWords.add(word);
            }
        }
        
        // Step 2: Assign all remaining words to the description column
        // This handles descriptions with large gaps, multi-word phrases, etc.
        // ANY word not assigned to a structured column goes here
        if (colTypes.descCol >= 0 && colTypes.descCol < columns.length) {
            const unassignedWords = line.words.filter(word => !assignedWords.has(word));
            
            // Sort unassigned words by Y position first (line order), then X position (left to right)
            // This maintains proper reading order across multiple lines within the same logical row
            unassignedWords.sort((a, b) => {
                const yDiff = a.y - b.y;
                if (Math.abs(yDiff) > 5) return yDiff; // Different lines (>5px apart)
                return a.x - b.x; // Same line, sort by X
            });
            
            lineData[colTypes.descCol].push(...unassignedWords);
        } else {
            // Fallback: If no description column identified, assign unassigned words
            // to the column with the largest X range (likely the description)
            const unassignedWords = line.words.filter(word => !assignedWords.has(word));
            
            if (unassignedWords.length > 0) {
                // Find widest column that doesn't have assigned words yet
                let widestCol = 0;
                let widestRange = 0;
                
                for (let i = 0; i < columns.length; i++) {
                    const range = columns[i].xMax - columns[i].xMin;
                    if (range > widestRange && lineData[i].length === 0) {
                        widestRange = range;
                        widestCol = i;
                    }
                }
                
                unassignedWords.sort((a, b) => a.x - b.x);
                lineData[widestCol].push(...unassignedWords);
            }
        }
        
        result.push({
            lineData,
            y: line.y,
            page: line.page
        });
    }
    
    return result;
}

/**
 * Check if a cell contains a date value using generic pattern matching
 * 
 * Supports multiple date formats to work across different banks:
 * - ISO: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD
 * - Standard: DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY, DD.MM.YYYY
 * - Short: DD/MM, MM/DD
 * - Compact: DDMMYYYY, DDMMYY
 * - Month names: DD Mon YYYY, DD Month YYYY
 * 
 * @param {Array} words - Array of word objects in the cell
 * @returns {boolean} True if cell contains a date in any supported format
 */
function cellContainsDate(words) {
    if (!words || words.length === 0) return false;
    
    // Get text with and without spaces to handle different formats
    const text = words.map(w => w.text).join('').trim();
    const textWithoutSpaces = text.replace(/\s+/g, '');
    const textWithSingleSpaces = words.map(w => w.text).join(' ').trim();
    
    // Try each pattern against both versions of the text
    for (const pattern of DATE_PATTERNS) {
        if (pattern.test(textWithoutSpaces) || pattern.test(textWithSingleSpaces)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Group lines into rows using date column as delimiter
 * 
 * Lines without a date in the date column are merged with the previous row.
 * This handles multi-line descriptions correctly.
 * 
 * @param {Array} columnData - Result from assignWordsToColumns
 * @param {number} dateColumnIndex - Index of the date column (usually 0)
 * @returns {Array} Array of row objects, each containing merged cell data
 */
function groupRowsByDateColumn(columnData, dateColumnIndex = 0) {
    if (!columnData || columnData.length === 0) return [];
    
    const rows = [];
    let currentRow = null;
    
    for (const lineRow of columnData) {
        const dateCell = lineRow.lineData[dateColumnIndex];
        const hasDate = cellContainsDate(dateCell);
        
        if (hasDate) {
            // Start a new row
            if (currentRow) {
                rows.push(currentRow);
            }
            currentRow = {
                cells: lineRow.lineData.map(cell => [...cell]),
                startY: lineRow.y,
                endY: lineRow.y,
                page: lineRow.page
            };
        } else if (currentRow) {
            // Merge with current row (multi-line description)
            // Wrapped continuation text often appears at the date column X position
            // but should be added to the description, not to the date column itself

            // Determine description column index
            let descColIndex = -1;
            for (let i = 0; i < lineRow.lineData.length; i++) {
                if (i !== dateColumnIndex && lineRow.lineData[i].length > 0) {
                    descColIndex = i;
                    break;
                }
            }

            if (descColIndex === -1 && lineRow.lineData.length > 1) {
                descColIndex = 1;
            }

            for (let i = 0; i < lineRow.lineData.length; i++) {
                if (lineRow.lineData[i].length > 0) {
                    if (i === dateColumnIndex) {
                        if (descColIndex >= 0 && descColIndex < currentRow.cells.length) {
                            currentRow.cells[descColIndex].push(...lineRow.lineData[i]);
                        }
                    } else {
                        currentRow.cells[i].push(...lineRow.lineData[i]);
                    }
                }
            }
            currentRow.endY = lineRow.y;
        }
        // If no current row and no date, skip the line (probably header remnant)
    }
    
    // Don't forget the last row
    if (currentRow) {
        rows.push(currentRow);
    }
    
    return rows;
}

/**
 * Determine column types based on header names and content
 * 
 * @param {Array} columns - Column definitions from header
 * @returns {Object} Column type mapping { dateCol, descCol, amountCols, balanceCol }
 */
function determineColumnTypes(columns) {
    const result = {
        dateCol: -1,
        descCol: -1,
        amountCols: [],
        balanceCol: -1
    };
    
    for (const col of columns) {
        const name = col.name.toLowerCase();
        // Also check a space-collapsed version for OCR artifacts like "W ITHDRAWAL"
        const nameNorm = name.replace(/\s+/g, '');
        // Strip currency symbols for matching (handles "£ OUT", "$ Amount", etc.)
        const nameStripped = name.replace(/[£$€¥₹₽₩₪฿₫₦₱₿¢()]/g, '').trim();
        const nameStrippedNorm = nameStripped.replace(/\s+/g, '');

        // Date column detection
        if (name.includes('date') || name === 'posted' || name.includes('value date') ||
            nameNorm.includes('valuedate') || nameNorm.includes('transdate') || nameNorm.includes('postdate')) {
            if (result.dateCol === -1) {
                result.dateCol = col.index;
            }
        }
        // Description column detection
        else if (name.includes('description') || name.includes('details') ||
                   name.includes('merchant') || name.includes('payee') ||
                   name.includes('remarks') || name.includes('particulars') ||
                   name.includes('narration') || name === 'transaction' ||
                   nameNorm === 'description' || nameNorm === 'transactiondetails') {
            result.descCol = col.index;
        }
        // Balance column detection
        else if (name.includes('balance') || nameNorm.includes('balance') ||
                   nameStrippedNorm.includes('balance')) {
            result.balanceCol = col.index;
        }
        // Amount column detection — check original, space-collapsed, and currency-stripped
        else if (name.includes('amount') || name.includes('deposit') ||
                   name.includes('withdrawal') || name.includes('credit') ||
                   name.includes('debit') || name === 'dr' || name === 'cr' ||
                   name === 'in' || name === 'out' ||
                   nameStripped === 'in' || nameStripped === 'out' ||
                   name.includes('money in') || name.includes('money out') ||
                   name.includes('paid in') || name.includes('paid out') ||
                   nameNorm.includes('amount') || nameNorm.includes('deposit') ||
                   nameNorm.includes('withdrawal') || nameNorm.includes('credit') ||
                   nameNorm.includes('debit') || nameNorm.includes('paidin') ||
                   nameNorm.includes('paidout') || nameNorm.includes('moneyin') ||
                   nameNorm.includes('moneyout') ||
                   nameStrippedNorm.includes('amount') || nameStrippedNorm.includes('deposit') ||
                   nameStrippedNorm.includes('withdrawal') || nameStrippedNorm.includes('credit') ||
                   nameStrippedNorm.includes('debit') ||
                   nameStrippedNorm === 'in' || nameStrippedNorm === 'out' ||
                   nameStrippedNorm === 'dr' || nameStrippedNorm === 'cr') {
            result.amountCols.push(col.index);
        }
    }
    
    // If no date column found, look for column with "tran" that isn't "transaction"
    if (result.dateCol === -1) {
        for (const col of columns) {
            const name = col.name.toLowerCase();
            if (name.includes('tran') && name.includes('date')) {
                result.dateCol = col.index;
                break;
            }
        }
    }
    
    // If still no date column, assume first column
    if (result.dateCol === -1 && columns.length > 0) {
        result.dateCol = 0;
    }
    
    // If no description column found, assume second column or largest gap
    if (result.descCol === -1 && columns.length > 1) {
        result.descCol = 1;
    }
    
    // If no amount columns found, look for remaining columns
    if (result.amountCols.length === 0) {
        for (const col of columns) {
            if (col.index !== result.dateCol && 
                col.index !== result.descCol && 
                col.index !== result.balanceCol) {
                result.amountCols.push(col.index);
            }
        }
    }
    
    return result;
}

/**
 * Split merged rows that contain multiple transactions.
 *
 * After groupRowsByDateColumn, a single row may contain multiple transactions
 * if they share the same date. This function detects when amount/balance columns
 * have multiple numeric values and splits the row into individual transactions.
 *
 * @param {Array} rows - Grouped rows from groupRowsByDateColumn
 * @param {Array} columns - Column definitions
 * @returns {Array} Rows with multi-transaction rows split apart
 */
function splitMultiValueRows(rows, columns) {
    const colTypes = determineColumnTypes(columns);
    // Need at least one known amount or balance column to detect multi-value rows
    const splitCols = [...colTypes.amountCols];
    if (colTypes.balanceCol >= 0) splitCols.push(colTypes.balanceCol);
    if (splitCols.length === 0) return rows;

    const result = [];
    for (const row of rows) {
        // Find the column with the MOST numeric values — that's the best split indicator.
        // Prefer balance (every tx has one), then try amount columns.
        let primaryCol = -1;
        let maxNumericCount = 0;
        for (const colIdx of splitCols) {
            if (colIdx >= row.cells.length) continue;
            const count = row.cells[colIdx].filter(w => {
                const cleaned = w.text.replace(/[$€£¥₹,\s]/g, '');
                return /^\-?\d+(\.\d+)?$/.test(cleaned);
            }).length;
            if (count > maxNumericCount) {
                maxNumericCount = count;
                primaryCol = colIdx;
            }
        }
        if (primaryCol < 0 || primaryCol >= row.cells.length) { result.push(row); continue; }

        const numericWords = row.cells[primaryCol].filter(w => {
            const cleaned = w.text.replace(/[$€£¥₹,\s]/g, '');
            return /^\-?\d+(\.\d+)?$/.test(cleaned);
        });

        if (numericWords.length <= 1) {
            // Single transaction, no split needed
            result.push(row);
            continue;
        }

        // Multiple values — need to split this row by Y position
        // Group all words in the row by their Y position (line within the row)
        const allWords = [];
        for (let colIdx = 0; colIdx < row.cells.length; colIdx++) {
            for (const word of row.cells[colIdx]) {
                allWords.push({ ...word, _colIdx: colIdx });
            }
        }
        // Sort by Y to find distinct visual lines
        allWords.sort((a, b) => a.y - b.y);

        // Group into visual lines using Y threshold
        const yThreshold = POSITION_CONFIG.Y_THRESHOLD;
        const visualLines = [];
        let curLine = null;
        for (const w of allWords) {
            if (curLine && Math.abs(curLine.y - w.y) <= yThreshold) {
                curLine.words.push(w);
            } else {
                if (curLine) visualLines.push(curLine);
                curLine = { y: w.y, words: [w] };
            }
        }
        if (curLine) visualLines.push(curLine);

        // Now group visual lines into sub-transactions.
        // A visual line that has a value in the primary split column starts a new sub-transaction.
        const subTransactions = [];
        let currentSub = null;
        for (const vl of visualLines) {
            const hasPrimaryValue = vl.words.some(w =>
                w._colIdx === primaryCol &&
                /^\-?\d+(\.\d+)?$/.test(w.text.replace(/[$€£¥₹,\s]/g, ''))
            );
            if (hasPrimaryValue && currentSub && currentSub.cells.some(c => c.length > 0)) {
                // Close current sub-transaction and start new
                subTransactions.push(currentSub);
                currentSub = { cells: row.cells.map(() => []), page: row.page };
            }
            if (!currentSub) {
                currentSub = { cells: row.cells.map(() => []), page: row.page };
            }
            // Add words to their respective columns
            for (const w of vl.words) {
                currentSub.cells[w._colIdx].push(w);
            }
        }
        if (currentSub) subTransactions.push(currentSub);

        // Validate split: each sub-transaction should have description text.
        // Sub-transactions that only have amounts (no description) are artifacts
        // of multi-line descriptions and should be merged back.
        const descCol = colTypes.descCol >= 0 ? colTypes.descCol : (colTypes.dateCol + 1);
        if (subTransactions.length > 1 && descCol >= 0) {
            const validated = [];
            for (const sub of subTransactions) {
                const hasDesc = descCol < sub.cells.length && sub.cells[descCol].length > 0;
                if (hasDesc || validated.length === 0) {
                    validated.push(sub);
                } else {
                    // No description — merge back into previous sub-transaction
                    const prev = validated[validated.length - 1];
                    for (let i = 0; i < sub.cells.length; i++) {
                        prev.cells[i].push(...sub.cells[i]);
                    }
                }
            }
            if (validated.length > 1) {
                result.push(...validated);
            } else {
                result.push(row);
            }
        } else if (subTransactions.length > 1) {
            result.push(...subTransactions);
        } else {
            result.push(row);
        }
    }
    return result;
}

/**
 * Parse a table to transactions
 *
 * Stores transaction data using the original column names from the PDF as keys.
 * This ensures CSV generation works correctly with dynamic headers.
 *
 * @param {Array} rows - Grouped row data from groupRowsByDateColumn
 * @param {Array} columns - Column definitions
 * @returns {Array} Array of transaction objects
 */
function parseTableToTransactions(rows, columns) {
    // Split merged rows that contain multiple transactions
    const splitRows = splitMultiValueRows(rows, columns);
    const transactions = [];
    const colTypes = determineColumnTypes(columns);

    for (const row of splitRows) {
        // Extract cell values
        const cellValues = row.cells.map(cell => 
            cell.map(w => w.text).join(' ').trim()
        );
        
        // Skip rows that look like noise or balance summary lines
        const allText = cellValues.join(' ').toLowerCase();
        if (NOISE_WORDS.some(w => allText === w) || allText.length < 3) {
            continue;
        }
        
        // Skip beginning/opening/ending balance summary rows (not actual transactions)
        // if (allText.includes('beginning balance') || 
        //     allText.includes('opening balance') ||
        //     allText.includes('ending balance') ||
        //     allText.startsWith('beginning') ||
        //     allText.startsWith('opening') ||
        //     allText.startsWith('ending')) {
        //     continue;
        // }
        
        // Build transaction object using original column names as keys
        // This matches the headers which preserve original casing
        const transaction = {};
        let hasData = false;

        for (let i = 0; i < columns.length && i < cellValues.length; i++) {
            const colName = columns[i].name;
            let value = cellValues[i] || '';
            
            // Clean description columns
            if (i === colTypes.descCol && value) {
                value = cleanDescription(value);
            }
            
            // Parse amount/balance columns as numbers where possible
            const colNameLower = columns[i].name.toLowerCase();
            if (colNameLower.includes('amount') || colNameLower.includes('balance') ||
                colNameLower.includes('credit') || colNameLower.includes('debit') ||
                colNameLower.includes('deposit') || colNameLower.includes('withdrawal')) {
                if (value) {
                    // Keep original string for display (e.g., "300.00 (Dr)")
                    transaction[colName] = value;
                }
            } else {
                transaction[colName] = value;
            }
            
            if (value) {
                hasData = true;
            }
        }
        
        // Also add standardized properties for compatibility with existing code
        if (colTypes.dateCol >= 0) {
            transaction.date = cellValues[colTypes.dateCol] || '';
        }
        if (colTypes.descCol >= 0) {
            transaction.description = cleanDescription(cellValues[colTypes.descCol] || '');
        }
        
        // Handle amount - try to extract numeric value
        if (colTypes.amountCols.length >= 1) {
            const amountStr = cellValues[colTypes.amountCols[0]] || '';
            if (amountStr) {
                transaction.amount = parseAmount(amountStr);
            }
        }
        
        // Handle balance
        if (colTypes.balanceCol >= 0) {
            const balanceStr = cellValues[colTypes.balanceCol] || '';
            if (balanceStr) {
                transaction.balance = parseAmount(balanceStr);
            }
        }
        
        // Only add if we have meaningful data
        if (hasData) {
            transactions.push(transaction);
        }
    }
    
    return transactions;
}

/**
 * Get lines between two indices (same page only)
 * 
 * @param {Array} lines - All lines
 * @param {number} startIndex - Start index (exclusive)
 * @param {number} endIndex - End index (inclusive)
 * @returns {Array} Lines between start and end
 */
function getLinesBetween(lines, startIndex, endIndex) {
    return lines.slice(startIndex + 1, endIndex + 1);
}

/**
 * Flatten words from all pages into a single array
 * 
 * @param {Array} pages - Pages data from extraction
 * @returns {Array} Flattened array of all words
 */
function flattenWords(pages) {
    // First pass: Count words to detect PDF-wide height issues
    let totalWords = 0;
    let smallHeightWords = 0;
    
    for (const page of pages) {
        if (page.words) {
            for (const word of page.words) {
                totalWords++;
                if (word.height && word.height < MIN_WORD_HEIGHT) {
                    smallHeightWords++;
                }
            }
        }
    }
    
    // Adaptive filtering: If too many words have small heights, it's a PDF-wide issue
    // In such cases, disable height filtering entirely (metrics are unreliable)
    const hasWidespreadHeightIssue = totalWords > 0 && (smallHeightWords / totalWords) > POSITION_CONFIG.HEIGHT_ISSUE_RATIO;
    
    // Second pass: Filter words based on detected PDF characteristics
    const allWords = [];
    
    for (const page of pages) {
        if (page.words) {
            for (const word of page.words) {
                if (hasWidespreadHeightIssue) {
                    // PDF has anomalous height metrics - skip filtering, include all words
                    // Rely on downstream parsers to filter actual artifacts based on content
                    allWords.push({
                        ...word,
                        page: page.pageNum
                    });
                } else {
                    // Normal PDF - use standard filtering with height and fontSize fallback
                    const hasValidHeight = word.height && word.height >= MIN_WORD_HEIGHT;
                    const hasValidFontSize = word.fontSize && word.fontSize >= MIN_FONT_SIZE;
                    
                    if (hasValidHeight || hasValidFontSize) {
                        allWords.push({
                            ...word,
                            page: page.pageNum
                        });
                    }
                }
            }
        }
    }
    
    return allWords;
}

/**
 * Process data lines into transactions using provided column definitions
 * 
 * Shared helper used by both explicit-header tables and continuation pages.
 * Handles word splitting, column assignment, date-based row grouping.
 * 
 * @param {Array} dataLines - Array of line objects to process
 * @param {Array} columns - Column definitions to apply
 * @returns {Array} Array of transaction objects
 */
function processDataLinesToTransactions(dataLines, columns) {
    // SPLIT WORDS: Split words that span multiple column boundaries
    const processedDataLines = dataLines.map(line => ({
        ...line,
        words: splitWordsByColumnBoundaries(line.words, columns)
    }));
    
    // Assign words to columns
    const columnData = assignWordsToColumns(processedDataLines, columns);
    
    // Determine date column
    const colTypes = determineColumnTypes(columns);
    
    // Group by date column
    const rows = groupRowsByDateColumn(columnData, colTypes.dateCol);

    // Parse to transactions
    return parseTableToTransactions(rows, columns);
}

/**
 * Main parsing function using position data
 * 
 * @param {Array} pages - Pages data from extraction with word positions
 * @returns {Object} Parser result with transactions, headers, and metadata
 */
function parseWithPositions(pages) {
    if (!pages || pages.length === 0) {
        return createResult(false, [], [], {}, 'No page data provided');
    }
    
    try {
        // Flatten all words
        const allWords = flattenWords(pages);
        
        if (allWords.length === 0) {
            return createResult(false, [], [], {}, 'No words extracted from PDF');
        }
        
        // Group into lines
        const lines = groupWordsIntoLines(allWords);
        
        if (lines.length === 0) {
            return createResult(false, [], [], {}, 'Could not group words into lines');
        }
        
        // Find all table headers
        const headers = findTableHeaders(lines);
        
        if (headers.length === 0) {
            return createResult(false, [], [], {}, 'No table headers found in document');
        }
        
        let allTransactions = [];
        let primaryColumns = null;

        // Track which pages have explicit headers (for continuation detection)
        const pagesWithHeaders = new Set(headers.map(h => h.page));

        // Track the most recent column structure per page for continuation
        const lastColumnsByPage = {};

        // Track per-table results to pick the best table group
        const tableResults = [];

        // Process each explicitly-detected table
        for (const header of headers) {
            // Find table bottom
            const { endIndex } = findTableBottom(lines, header.lineIndex);

            // Build columns from header
            let columns = buildColumnsFromHeader(header.line);

            if (columns.length === 0) continue;

            // Get data lines between header and bottom
            const dataLines = getLinesBetween(lines, header.lineIndex, endIndex);

            if (dataLines.length === 0) continue;

            // DETECT HIDDEN COLUMN BOUNDARIES: Analyze vertical alignment patterns
            // This detects when multiple columns are combined (e.g., "Date Reference Number")
            // by finding consistent X positions across data rows
            columns = detectVerticalAlignmentPatterns(dataLines, columns);

            // Remember column structure for this page (used for continuation pages)
            lastColumnsByPage[header.page] = columns;

            // Process data lines into transactions
            const transactions = processDataLinesToTransactions(dataLines, columns);
            tableResults.push({ columns, transactions, page: header.page, headerNames: columns.map(c => c.name) });
        }

        // Group tables by structure (same column count + similar names = continuations of same table)
        // Then pick the group with the most total transactions as primary
        if (tableResults.length > 1) {
            const groups = [];
            for (const table of tableResults) {
                const sig = table.columns.length + ':' + table.headerNames.join('|').toLowerCase();
                let found = groups.find(g => g.sig === sig);
                if (!found) {
                    found = { sig, columns: table.columns, tables: [], totalTx: 0 };
                    groups.push(found);
                }
                found.tables.push(table);
                found.totalTx += table.transactions.length;
            }
            // Pick the group with most transactions
            const best = groups.reduce((a, b) => a.totalTx > b.totalTx ? a : b, groups[0]);
            primaryColumns = best.columns;
            allTransactions = best.tables.flatMap(t => t.transactions);
            // Update pagesWithHeaders/lastColumnsByPage for continuation to use best group
            for (const table of best.tables) {
                lastColumnsByPage[table.page] = table.columns;
            }
        } else if (tableResults.length === 1) {
            primaryColumns = tableResults[0].columns;
            allTransactions = tableResults[0].transactions;
        }
        
        // ─── Multi-page continuity ──────────────────────────────────────
        // Detect pages that have no headers but follow a page with a table.
        // Apply the previous page's column structure to capture continuation data.
        const allPages = [...new Set(lines.map(l => l.page))].sort((a, b) => a - b);
        
        for (const pageNum of allPages) {
            if (pagesWithHeaders.has(pageNum)) continue;
            
            // Find the closest preceding page that had column structure
            let carryForwardColumns = null;
            for (let prev = pageNum - 1; prev >= 1; prev--) {
                if (lastColumnsByPage[prev]) {
                    carryForwardColumns = lastColumnsByPage[prev];
                    break;
                }
            }
            
            if (!carryForwardColumns) continue;
            
            // Get all lines on this continuation page
            const pageLines = lines.filter(l => l.page === pageNum);
            if (pageLines.length === 0) continue;
            
            // Filter out likely non-data lines (footers, page numbers, etc.)
            const candidateLines = pageLines.filter(line => {
                const lineText = line.words.map(w => w.text).join(' ');
                // Skip lines that match end-of-table markers
                if (END_OF_TABLE_PATTERNS.some(p => p.test(lineText))) return false;
                // Skip very short lines (likely noise)
                if (lineText.trim().length < 3) return false;
                return true;
            });
            
            if (candidateLines.length === 0) continue;
            
            // Check if any of these lines contain dates (strong signal of transaction data)
            const colTypes = determineColumnTypes(carryForwardColumns);
            const hasTransactionData = candidateLines.some(line => {
                // Check if any word in the date column region contains a date
                for (const word of line.words) {
                    const wordCenter = word.x + word.width / 2;
                    if (colTypes.dateCol >= 0 && carryForwardColumns[colTypes.dateCol]) {
                        const dateCol = carryForwardColumns[colTypes.dateCol];
                        if (wordCenter >= dateCol.xMin && wordCenter <= dateCol.xMax) {
                            const textNoSpaces = word.text.replace(/\s+/g, '');
                            if (DATE_PATTERNS.some(p => p.test(textNoSpaces))) return true;
                        }
                    }
                }
                return false;
            });
            
            if (!hasTransactionData) continue;
            
            // Parse continuation data using carried-forward columns
            const transactions = processDataLinesToTransactions(candidateLines, carryForwardColumns);
            if (transactions.length > 0) {
                allTransactions.push(...transactions);
                // Carry this page's structure forward too
                lastColumnsByPage[pageNum] = carryForwardColumns;
            }
        }
        
        // Build headers from primary columns — preserve original casing from the PDF
        const outputHeaders = primaryColumns ?
            primaryColumns.map(c => c.name) :
            ['Date', 'Description', 'Amount'];
        
        const metadata = {
            bank: 'unknown',
            statementType: 'generic',
            parserType: 'position-based',
            tablesFound: headers.length,
            continuationPagesUsed: Object.keys(lastColumnsByPage).length - pagesWithHeaders.size,
            transactionCount: allTransactions.length
        };
        
        return createResult(
            allTransactions.length > 0,
            allTransactions,
            outputHeaders,
            metadata,
            allTransactions.length === 0 ? 'No transactions could be extracted' : null
        );
        
    } catch (error) {
        return createResult(false, [], [], {}, `Position parsing error: ${error.message}`);
    }
}

export {
    // Core parsing function
    parseWithPositions,
    
    // Utility functions (exported for testing/reuse)
    groupWordsIntoLines,
    findTableHeaders,
    findTableBottom,
    buildColumnsFromHeader,
    assignWordsToColumns,
    groupRowsByDateColumn,
    parseTableToTransactions,
    flattenWords,
    
    // Constants
    HEADER_PATTERNS
};
