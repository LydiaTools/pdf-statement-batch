/**
 * Rectangle-Based Table Parser
 * 
 * Uses PDF drawing elements (rectangles, lines) to improve table detection.
 * Falls back to position-based heuristics when no visual elements are present.
 * 
 * Advantages over pure position-based parsing:
 * - More accurate table boundary detection using visible borders
 * - Better column detection using vertical lines/borders
 * - More reliable row detection using horizontal lines
 * - Handles inconsistent text positioning within cells
 */

import { parseAmount, cleanDescription, createResult, DATE_PATTERNS } from './base-parser.js';

// Header keywords for validating whether a row is a table header vs data
// Shared vocabulary with position-parser to ensure consistent detection.
const HEADER_KEYWORDS = [
    'date', 'trans date', 'tran date', 'transaction date', 'posted', 'post date', 'value date',
    'description', 'details', 'transaction details', 'merchant', 'payee', 'remarks', 'particulars', 'narration',
    'amount', 'deposit', 'withdrawal', 'credit', 'debit', 'balance', 'deposits', 'withdrawals', 'dr', 'cr',
    'reference', 'ref', 'check', 'cheque', 'sl', 'no'
];

// ─── Rectangle Parser Configuration ────────────────────────────────────────
// Centralized thresholds for tuning rectangle-based table detection.
const RECTANGLE_CONFIG = {
    // Table region detection
    MIN_TABLE_RECT_WIDTH: 300,    // Min width (px) for a rectangle to be a table boundary
    MIN_TABLE_RECT_HEIGHT: 50,    // Min height (px) for a rectangle to be a table boundary
    MIN_CELL_RECTS: 20,           // Min rectangles on page to attempt cell-grid detection
    MIN_ROW_CLUSTERS: 3,          // Min row clusters to confirm a cell-grid table
    ROW_CLUSTER_Y_TOLERANCE: 5,   // Y-tolerance (px) for clustering cell rectangles into rows

    // Line-based detection
    LINE_GROUP_TOLERANCE: 10,     // Tolerance (px) for grouping lines by coordinate
    MIN_LINE_GROUPS: 2,           // Min groups of H/V lines to confirm a line-grid table

    // Column/row boundary detection
    BOUNDARY_GROUP_TOLERANCE: 2,  // Tolerance (px) for grouping boundary positions
    REGION_BOUNDARY_TOLERANCE: 3, // Tolerance (px) for line-in-region checks (handles sub-pixel misalignment)
    MIN_COL_LINE_HEIGHT_RATIO: 0.3, // Vertical line must span ≥30% of table height
    MIN_ROW_LINE_WIDTH_RATIO: 0.5,  // Horizontal line must span ≥50% of table width

    // Word gap analysis
    MIN_GAP_SIZE: 10,             // Min gap (px) between words to consider as column separator
    GAP_CLUSTER_X_TOLERANCE: 15,  // X-tolerance (px) for clustering gaps across rows
    MIN_GAP_ROW_RATIO: 0.5,      // Gap must appear in ≥50% of rows to be consistent
    MIN_GAP_OCCURRENCES: 2,       // Absolute minimum gap occurrences

    // Boundary validation
    MIN_VALID_COLUMN_RATIO: 0.7,  // ≥70% of columns must have words for boundaries to be valid

    // Word assignment
    WORD_Y_LINE_TOLERANCE: 5,     // Y-tolerance (px) for detecting same-line words in cells

    // Header resolution above cells
    HEADER_SEARCH_ABOVE_PX: 40,   // Max distance (px) above the first row boundary to search for header text

    // Strict boundary padding
    STRICT_BOUNDARY_PADDING: 5    // Extra px added to strict headerXMin/headerXMax to catch
                                  // data words slightly wider than narrow header words
};

/**
 * Find header text from page words above the first cell row
 * 
 * In some PDFs (e.g. Axis Bank), the header row text sits between the table's
 * top border and the first horizontal separator line.  Because row boundaries
 * are derived from horizontal lines, the header text falls *above* the first
 * row boundary and is never captured as a cell row.
 * 
 * This function looks for header-keyword-containing words in that gap and
 * maps them to the existing column definitions so we can replace generic
 * COL_N names with actual header text.
 * 
 * @param {Array} pageWords - All words on the page
 * @param {Array} rowBoundaries - Y positions of row separators (from horizontal lines)
 * @param {Array} columns - Column definitions with xMin/xMax
 * @param {Object} region - Table region bounds
 * @returns {Array|null} Array of header strings per column, or null if not found
 */
function findHeadersAboveCells(pageWords, rowBoundaries, columns, region) {
    if (!rowBoundaries || rowBoundaries.length === 0 || !columns || columns.length === 0) {
        return null;
    }
    
    const firstRowY = rowBoundaries[0];
    const searchMinY = firstRowY - RECTANGLE_CONFIG.HEADER_SEARCH_ABOVE_PX;
    
    // Collect words above the first row boundary, within the table's X extent
    // (with a small horizontal margin to catch slightly offset header words).
    // Exclude words wider than 50% of the table -- those are title/subtitle lines
    // (e.g. "Statement of Account No XYZ for period ..."), not column headers.
    const maxHeaderWordWidth = region.width * 0.5;
    const headerCandidates = pageWords.filter(w => {
        return w.y >= searchMinY &&
               w.y < firstRowY &&
               w.x >= (region.x - 10) &&
               w.x <= (region.x + region.width + 10) &&
               w.width <= maxHeaderWordWidth;
    });
    
    if (headerCandidates.length < 2) return null;
    
    // Check if these words contain enough header keywords to be a real header
    const combinedText = headerCandidates.map(w => w.text.toLowerCase()).join(' ');
    const keywordHits = HEADER_KEYWORDS.filter(kw => combinedText.includes(kw)).length;
    
    if (keywordHits < 2) return null;
    
    // Map each word to its column using the column xMin/xMax boundaries
    const resolvedHeaders = columns.map((_, idx) => `COL_${idx}`);
    
    // Sort by Y first (handle multi-line headers like "Init. / Br"), then X
    headerCandidates.sort((a, b) => {
        const yDiff = Math.abs(a.y - b.y);
        if (yDiff > RECTANGLE_CONFIG.WORD_Y_LINE_TOLERANCE) return a.y - b.y;
        return a.x - b.x;
    });
    
    for (const word of headerCandidates) {
        const wordCenter = word.x + word.width / 2;
        for (let colIdx = 0; colIdx < columns.length; colIdx++) {
            const col = columns[colIdx];
            if (wordCenter >= col.xMin && wordCenter <= col.xMax) {
                if (/^COL_\d+$/.test(resolvedHeaders[colIdx])) {
                    resolvedHeaders[colIdx] = word.text;
                } else {
                    // Append to existing header (multi-word or multi-line header)
                    resolvedHeaders[colIdx] += ' ' + word.text;
                }
                break;
            }
        }
    }
    
    // Only return if we resolved at least 2 columns to real names
    const resolvedCount = resolvedHeaders.filter(h => !/^COL_\d+$/.test(h)).length;
    if (resolvedCount < 2) return null;
    
    return resolvedHeaders;
}

/**
 * Detect table regions using rectangles and lines
 * 
 * Strategies:
 * 1. Large bounding rectangles (table borders)
 * 2. Line-based grids (horizontal and vertical lines)
 * 3. Cell rectangle grids (many small rectangles forming a table)
 * 
 * @param {Array} rectangles - Array of rectangle objects
 * @param {Array} horizontalLines - Array of horizontal line objects
 * @param {Array} verticalLines - Array of vertical line objects
 * @param {number} pageNum - Page number to analyze
 * @returns {Array} Array of detected table regions with bounds
 */
function detectTableRegions(rectangles, horizontalLines, verticalLines, pageNum) {
    const regions = [];
    
    // Filter elements for this page
    const pageRects = rectangles.filter(r => r.page === pageNum);
    const pageHLines = horizontalLines.filter(l => l.page === pageNum);
    const pageVLines = verticalLines.filter(l => l.page === pageNum);
    
    // Strategy 1: Look for rectangular table boundaries
    // Find large rectangles that likely enclose tables
    for (const rect of pageRects) {
        // Table rectangles are typically large and wide
        if (rect.width > RECTANGLE_CONFIG.MIN_TABLE_RECT_WIDTH && rect.height > RECTANGLE_CONFIG.MIN_TABLE_RECT_HEIGHT) {
            regions.push({
                type: 'rectangle',
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                page: pageNum
            });
        }
    }
    
    // Strategy 2: Look for cell rectangle grids
    // Many small rectangles forming a table (like Union Bank)
    if (pageRects.length > RECTANGLE_CONFIG.MIN_CELL_RECTS && regions.length === 0) {
        // Cluster rectangles by Y position to find rows
        const rowClusters = [];
        const yTolerance = RECTANGLE_CONFIG.ROW_CLUSTER_Y_TOLERANCE;
        
        for (const rect of pageRects) {
            let foundCluster = false;
            for (const cluster of rowClusters) {
                if (Math.abs(rect.y - cluster.y) <= yTolerance) {
                    cluster.rects.push(rect);
                    cluster.minX = Math.min(cluster.minX, rect.x);
                    cluster.maxX = Math.max(cluster.maxX, rect.x + rect.width);
                    cluster.minY = Math.min(cluster.minY, rect.y);
                    cluster.maxY = Math.max(cluster.maxY, rect.y + rect.height);
                    foundCluster = true;
                    break;
                }
            }
            
            if (!foundCluster) {
                rowClusters.push({
                    y: rect.y,
                    rects: [rect],
                    minX: rect.x,
                    maxX: rect.x + rect.width,
                    minY: rect.y,
                    maxY: rect.y + rect.height
                });
            }
        }
        
        // If we have many rows of rectangles, it's likely a table
        if (rowClusters.length >= RECTANGLE_CONFIG.MIN_ROW_CLUSTERS) {
            // Find overall table bounds
            const minX = Math.min(...rowClusters.map(c => c.minX));
            const maxX = Math.max(...rowClusters.map(c => c.maxX));
            const minY = Math.min(...rowClusters.map(c => c.minY));
            const maxY = Math.max(...rowClusters.map(c => c.maxY));
            
            regions.push({
                type: 'cell-grid',
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
                cellRectangles: pageRects,
                page: pageNum
            });
        }
    }
    
    // Strategy 3: Look for line-based table boundaries
    // Group horizontal lines to find table top/bottom
    const hLinesByY = groupLinesByCoordinate(pageHLines, 'y', RECTANGLE_CONFIG.LINE_GROUP_TOLERANCE);
    const vLinesByX = groupLinesByCoordinate(pageVLines, 'x', RECTANGLE_CONFIG.LINE_GROUP_TOLERANCE);
    
    // If we have multiple horizontal and vertical lines, likely a table
    if (hLinesByY.length >= RECTANGLE_CONFIG.MIN_LINE_GROUPS && vLinesByX.length >= RECTANGLE_CONFIG.MIN_LINE_GROUPS) {
        // Find table bounds from line positions
        const minY = Math.min(...pageHLines.map(l => l.y));
        const maxY = Math.max(...pageHLines.map(l => l.y));
        const minX = Math.min(...pageVLines.map(l => l.x));
        const maxX = Math.max(...pageVLines.map(l => l.x));
        
        regions.push({
            type: 'line-grid',
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
            horizontalLines: pageHLines,
            verticalLines: pageVLines,
            page: pageNum
        });
    }
    
    return regions;
}

/**
 * Group lines by coordinate with tolerance
 * 
 * @param {Array} lines - Array of line objects
 * @param {string} coord - Coordinate to group by ('x' or 'y')
 * @param {number} tolerance - Grouping tolerance in pixels
 * @returns {Array} Array of line groups
 */
function groupLinesByCoordinate(lines, coord, tolerance = 5) {
    if (lines.length === 0) return [];
    
    const sorted = [...lines].sort((a, b) => a[coord] - b[coord]);
    const groups = [];
    let currentGroup = [sorted[0]];
    
    for (let i = 1; i < sorted.length; i++) {
        const prevCoord = sorted[i - 1][coord];
        const currCoord = sorted[i][coord];
        
        if (Math.abs(currCoord - prevCoord) <= tolerance) {
            currentGroup.push(sorted[i]);
        } else {
            groups.push(currentGroup);
            currentGroup = [sorted[i]];
        }
    }
    
    groups.push(currentGroup);
    return groups;
}

/**
 * Detect column boundaries from cell rectangles
 * 
 * When PDF has individual cell rectangles (like Union Bank), extract
 * column positions from rectangle edges.
 * 
 * @param {Array} cellRectangles - Array of cell rectangle objects
 * @param {Object} tableRegion - Table region bounds
 * @returns {Array} Array of column boundaries (x positions)
 */
function detectColumnBoundariesFromCellRectangles(cellRectangles, tableRegion) {
    if (!cellRectangles || cellRectangles.length === 0) return [];
    
    // Collect unique X positions (left and right edges of cells)
    const xPositions = new Set();
    
    cellRectangles.forEach(rect => {
        xPositions.add(Math.round(rect.x));
        xPositions.add(Math.round(rect.x + rect.width));
    });
    
    // Sort and filter to get column boundaries
    const sortedX = Array.from(xPositions).sort((a, b) => a - b);
    
    // Group nearby X positions (within 2px) - they're the same boundary
    const boundaries = [];
    let currentGroup = [sortedX[0]];
    
    for (let i = 1; i < sortedX.length; i++) {
        if (sortedX[i] - sortedX[i - 1] <= RECTANGLE_CONFIG.BOUNDARY_GROUP_TOLERANCE) {
            currentGroup.push(sortedX[i]);
        } else {
            // Average the group to get boundary position
            const avg = currentGroup.reduce((sum, x) => sum + x, 0) / currentGroup.length;
            boundaries.push(avg);
            currentGroup = [sortedX[i]];
        }
    }
    
    // Don't forget last group
    if (currentGroup.length > 0) {
        const avg = currentGroup.reduce((sum, x) => sum + x, 0) / currentGroup.length;
        boundaries.push(avg);
    }
    
    // Remove first and last boundary (table edges)
    if (boundaries.length > 2) {
        return boundaries.slice(1, -1); // Return only internal boundaries
    }
    
    return [];
}

/**
 * Detect row boundaries from cell rectangles
 * 
 * @param {Array} cellRectangles - Array of cell rectangle objects
 * @param {Object} tableRegion - Table region bounds
 * @returns {Array} Array of row boundaries (y positions)
 */
function detectRowBoundariesFromCellRectangles(cellRectangles, tableRegion) {
    if (!cellRectangles || cellRectangles.length === 0) return [];
    
    // Collect unique Y positions (top and bottom edges of cells)
    const yPositions = new Set();
    
    cellRectangles.forEach(rect => {
        yPositions.add(Math.round(rect.y));
        yPositions.add(Math.round(rect.y + rect.height));
    });
    
    // Sort and filter
    const sortedY = Array.from(yPositions).sort((a, b) => a - b);
    
    // Group nearby Y positions (within 2px)
    const boundaries = [];
    let currentGroup = [sortedY[0]];
    
    for (let i = 1; i < sortedY.length; i++) {
        if (sortedY[i] - sortedY[i - 1] <= RECTANGLE_CONFIG.BOUNDARY_GROUP_TOLERANCE) {
            currentGroup.push(sortedY[i]);
        } else {
            const avg = currentGroup.reduce((sum, y) => sum + y, 0) / currentGroup.length;
            boundaries.push(avg);
            currentGroup = [sortedY[i]];
        }
    }
    
    if (currentGroup.length > 0) {
        const avg = currentGroup.reduce((sum, y) => sum + y, 0) / currentGroup.length;
        boundaries.push(avg);
    }
    
    return boundaries;
}

/**
 * Detect column boundaries using vertical lines
 * 
 * @param {Array} verticalLines - Array of vertical line objects
 * @param {Object} tableRegion - Table region bounds
 * @returns {Array} Array of column boundaries (x positions)
 */
function detectColumnBoundariesFromLines(verticalLines, tableRegion) {
    // Filter vertical lines that span most of the table height
    const minHeight = tableRegion.height * RECTANGLE_CONFIG.MIN_COL_LINE_HEIGHT_RATIO;
    const tol = RECTANGLE_CONFIG.REGION_BOUNDARY_TOLERANCE;
    
    const columnLines = verticalLines.filter(line => {
        // Use tolerance to handle sub-pixel misalignment between line endpoints
        // and table region bounds
        const lineInRegion = line.y1 >= (tableRegion.y - tol) && 
                            line.y2 <= (tableRegion.y + tableRegion.height + tol);
        const lineHeight = line.length;
        
        // Exclude lines at the table edges -- these are border lines, not
        // internal column separators. Including them would create zero-width
        // columns at the left/right edges.
        const isEdgeLine = Math.abs(line.x - tableRegion.x) <= tol || 
                          Math.abs(line.x - (tableRegion.x + tableRegion.width)) <= tol;
        
        return lineInRegion && lineHeight >= minHeight && !isEdgeLine;
    });
    
    // Sort by x position
    columnLines.sort((a, b) => a.x - b.x);
    
    // Extract x positions
    return columnLines.map(line => line.x);
}

/**
 * Find gaps in a single row of words
 * 
 * @param {Array} rowWords - Words in a single row, sorted by X
 * @param {Object} tableRegion - Table region bounds
 * @returns {Array} Array of gap objects with xMin, xMax, center, width
 */
function findGapsInRow(rowWords, tableRegion) {
    if (!rowWords || rowWords.length === 0) return [];
    
    // Sort words by X position
    const sortedWords = [...rowWords].sort((a, b) => a.x - b.x);
    
    const gaps = [];
    
    for (let i = 0; i < sortedWords.length - 1; i++) {
        const currentWordEnd = sortedWords[i].x + sortedWords[i].width;
        const nextWordStart = sortedWords[i + 1].x;
        const gapSize = nextWordStart - currentWordEnd;
        
        // Only consider significant gaps (not just word spacing)
        if (gapSize > RECTANGLE_CONFIG.MIN_GAP_SIZE) {
            gaps.push({
                xMin: currentWordEnd,
                xMax: nextWordStart,
                center: (currentWordEnd + nextWordStart) / 2,
                width: gapSize
            });
        }
    }
    
    return gaps;
}

/**
 * Infer column boundaries from word positions using row-by-row gap consistency
 * 
 * Multi-step strategy:
 * 1. Find gaps in each row separately
 * 2. Cluster gaps across rows by X position (gaps at similar X = same boundary)
 * 3. Find consistent gaps that appear in most rows (voting/consensus)
 * 4. Return gap positions as column boundaries
 * 
 * This approach is more robust than histogram for misaligned tables.
 * 
 * @param {Array} words - Array of word objects in the table region
 * @param {Object} tableRegion - Table region bounds
 * @param {Array} rowBoundaries - Optional row boundaries to group words by row
 * @returns {Array} Array of inferred column boundaries (x positions)
 */
function inferColumnBoundariesFromWords(words, tableRegion, rowBoundaries = null) {
    if (!words || words.length === 0) return [];
    
    // Step 1: Group words by rows
    let rows = [];
    
    if (rowBoundaries && rowBoundaries.length > 1) {
        // Use provided row boundaries
        for (let i = 0; i < rowBoundaries.length - 1; i++) {
            const rowWords = words.filter(w => 
                w.y >= rowBoundaries[i] && w.y < rowBoundaries[i + 1]
            );
            if (rowWords.length > 0) {
                rows.push(rowWords);
            }
        }
    } else {
        // Group words by Y position (approximate rows)
        const yTolerance = RECTANGLE_CONFIG.WORD_Y_LINE_TOLERANCE;
        const sortedByY = [...words].sort((a, b) => a.y - b.y);
        
        let currentRow = [sortedByY[0]];
        for (let i = 1; i < sortedByY.length; i++) {
            if (Math.abs(sortedByY[i].y - sortedByY[i - 1].y) <= yTolerance) {
                currentRow.push(sortedByY[i]);
            } else {
                if (currentRow.length > 0) rows.push(currentRow);
                currentRow = [sortedByY[i]];
            }
        }
        if (currentRow.length > 0) rows.push(currentRow);
    }
    
    if (rows.length === 0) return [];
    
    // Step 2: Find gaps in each row
    const allGaps = [];
    for (const rowWords of rows) {
        const rowGaps = findGapsInRow(rowWords, tableRegion);
        allGaps.push(...rowGaps);
    }
    
    if (allGaps.length === 0) return [];
    
    // Step 3: Cluster gaps by X position (gaps at similar X = same boundary)
    const gapClusters = [];
    const xTolerance = RECTANGLE_CONFIG.GAP_CLUSTER_X_TOLERANCE;
    
    for (const gap of allGaps) {
        let foundCluster = false;
        
        for (const cluster of gapClusters) {
            if (Math.abs(gap.center - cluster.avgCenter) <= xTolerance) {
                // Add to existing cluster
                cluster.gaps.push(gap);
                cluster.avgCenter = cluster.gaps.reduce((sum, g) => sum + g.center, 0) / cluster.gaps.length;
                cluster.minX = Math.min(cluster.minX, gap.xMin);
                cluster.maxX = Math.max(cluster.maxX, gap.xMax);
                cluster.count++;
                foundCluster = true;
                break;
            }
        }
        
        if (!foundCluster) {
            // Create new cluster
            gapClusters.push({
                gaps: [gap],
                avgCenter: gap.center,
                minX: gap.xMin,
                maxX: gap.xMax,
                count: 1
            });
        }
    }
    
    // Step 4: Filter for consistent gaps (appear in most rows)
    // Use 50% threshold - gap must appear in at least half the rows
    const minOccurrences = Math.max(RECTANGLE_CONFIG.MIN_GAP_OCCURRENCES, Math.ceil(rows.length * RECTANGLE_CONFIG.MIN_GAP_ROW_RATIO));
    const consistentGaps = gapClusters.filter(cluster => cluster.count >= minOccurrences);
    
    // If no consistent gaps found, lower threshold
    if (consistentGaps.length === 0 && gapClusters.length > 0) {
        // Use gaps that appear at least twice
        consistentGaps.push(...gapClusters.filter(c => c.count >= RECTANGLE_CONFIG.MIN_GAP_OCCURRENCES));
    }
    
    // Step 5: Sort by X position (left to right)
    consistentGaps.sort((a, b) => a.avgCenter - b.avgCenter);
    
    // Return column boundary positions
    return consistentGaps.map(cluster => cluster.avgCenter);
}

/**
 * Detect row boundaries using horizontal lines
 * 
 * @param {Array} horizontalLines - Array of horizontal line objects
 * @param {Object} tableRegion - Table region bounds
 * @returns {Array} Array of row boundaries (y positions)
 */
function detectRowBoundariesFromLines(horizontalLines, tableRegion) {
    // Filter horizontal lines that span most of the table width
    const minWidth = tableRegion.width * RECTANGLE_CONFIG.MIN_ROW_LINE_WIDTH_RATIO;
    const tol = RECTANGLE_CONFIG.REGION_BOUNDARY_TOLERANCE;
    
    const rowLines = horizontalLines.filter(line => {
        // Use tolerance to handle sub-pixel misalignment between line endpoints
        // and table region bounds (e.g. border lines at x1=36.25 vs region.x=36.5)
        const lineInRegion = line.x1 >= (tableRegion.x - tol) && 
                            line.x2 <= (tableRegion.x + tableRegion.width + tol) &&
                            line.y >= (tableRegion.y - tol) &&
                            line.y <= (tableRegion.y + tableRegion.height + tol);
        const lineWidth = line.length;
        return lineInRegion && lineWidth >= minWidth;
    });
    
    // Sort by y position
    rowLines.sort((a, b) => a.y - b.y);
    
    // Extract y positions
    return rowLines.map(line => line.y);
}

/**
 * Create column definitions from detected boundaries
 * 
 * Strategy: Identify column types to properly handle description column
 * - First column: Usually DATE (narrow, left-aligned)
 * - Last 1-2 columns: Usually AMOUNT/BALANCE (narrow, right-aligned)
 * - Middle column(s): DESCRIPTION (widest, variable content)
 * 
 * Stores both boundary-based ranges (xMin/xMax) and header-based ranges
 * (headerXMin/headerXMax) for strict column assignment.
 * 
 * @param {Array} columnBoundaries - X positions of column separators
 * @param {Object} tableRegion - Table region bounds
 * @returns {Array} Array of column definitions with type hints
 */
function createColumnsFromBoundaries(columnBoundaries, tableRegion) {
    if (columnBoundaries.length === 0) {
        // No boundaries - return single column
        return [{
            index: 0,
            xMin: tableRegion.x,
            xMax: tableRegion.x + tableRegion.width,
            headerXMin: tableRegion.x,
            headerXMax: tableRegion.x + tableRegion.width,
            type: 'unknown'
        }];
    }
    
    const columns = [];
    
    // First column (from table start to first boundary)
    columns.push({
        index: 0,
        xMin: tableRegion.x,
        xMax: columnBoundaries[0],
        headerXMin: tableRegion.x,
        headerXMax: columnBoundaries[0],
        type: 'structured' // Likely DATE column
    });
    
    // Middle columns (between boundaries)
    for (let i = 1; i < columnBoundaries.length; i++) {
        columns.push({
            index: i,
            xMin: columnBoundaries[i - 1],
            xMax: columnBoundaries[i],
            headerXMin: columnBoundaries[i - 1],
            headerXMax: columnBoundaries[i],
            type: 'middle' // Could be DESCRIPTION or other structured columns
        });
    }
    
    // Last column (from last boundary to table end)
    columns.push({
        index: columns.length,
        xMin: columnBoundaries[columnBoundaries.length - 1],
        xMax: tableRegion.x + tableRegion.width,
        headerXMin: columnBoundaries[columnBoundaries.length - 1],
        headerXMax: tableRegion.x + tableRegion.width,
        type: 'structured' // Likely AMOUNT or BALANCE column
    });
    
    // Identify description column (widest middle column)
    if (columns.length > 2) {
        let widestIdx = -1;
        let widestWidth = 0;
        
        for (let i = 0; i < columns.length; i++) {
            const width = columns[i].xMax - columns[i].xMin;
            if (width > widestWidth && i > 0 && i < columns.length - 1) {
                widestWidth = width;
                widestIdx = i;
            }
        }
        
        if (widestIdx >= 0) {
            columns[widestIdx].type = 'description';
        }
    }
    
    return columns;
}

/**
 * Validate if column boundaries work for a given set of words
 * 
 * Checks if the boundaries create reasonable columns with actual data.
 * Returns false if boundaries result in too many empty columns.
 * 
 * @param {Array} columnBoundaries - X positions of column separators
 * @param {Array} words - Words to validate against
 * @param {Object} tableRegion - Table region bounds
 * @returns {boolean} True if boundaries are valid
 */
function validateColumnBoundaries(columnBoundaries, words, tableRegion) {
    if (columnBoundaries.length === 0) return false;
    
    const columns = createColumnsFromBoundaries(columnBoundaries, tableRegion);
    
    // Count how many columns have words
    const columnWordCounts = columns.map(() => 0);
    
    for (const word of words) {
        const wordCenter = word.x + word.width / 2;
        for (let i = 0; i < columns.length; i++) {
            if (wordCenter >= columns[i].xMin && wordCenter < columns[i].xMax) {
                columnWordCounts[i]++;
                break;
            }
        }
    }
    
    // Valid if at least 70% of columns have words
    const nonEmptyColumns = columnWordCounts.filter(count => count > 0).length;
    const validityRatio = nonEmptyColumns / columns.length;
    
    return validityRatio >= RECTANGLE_CONFIG.MIN_VALID_COLUMN_RATIO;
}

/**
 * Assign words to cells based on row and column boundaries
 * 
 * Strict boundary strategy:
 * 1. Assign words to structured columns using STRICT header boundaries (headerXMin to headerXMax)
 *    - Word center must be within original header word positions
 * 2. Assign all remaining words to description column as catch-all
 * 
 * This prevents words in gaps between headers from being incorrectly assigned,
 * improving accuracy for structured columns like date, amount, balance.
 * 
 * @param {Array} words - Array of word objects
 * @param {Array} rowBoundaries - Y positions of row separators
 * @param {Array} columns - Column definitions
 * @param {Object} tableRegion - Table region bounds
 * @returns {Array} 2D array of cells [row][col] = [words]
 */
function assignWordsToCells(words, rowBoundaries, columns, tableRegion) {
    // Create row ranges from boundaries
    const rows = [];
    
    if (rowBoundaries.length === 0) {
        // No row boundaries - treat as single row
        rows.push({
            yMin: tableRegion.y,
            yMax: tableRegion.y + tableRegion.height
        });
    } else {
        // Create rows between boundaries
        for (let i = 0; i < rowBoundaries.length - 1; i++) {
            rows.push({
                yMin: rowBoundaries[i],
                yMax: rowBoundaries[i + 1]
            });
        }
        
        // Safety net: if there is meaningful space after the last boundary
        // (i.e. the last boundary isn't the table bottom), add a final row
        // to capture any remaining data. This handles cases where the bottom
        // border line was excluded from row boundaries.
        const lastBoundary = rowBoundaries[rowBoundaries.length - 1];
        const tableBottom = tableRegion.y + tableRegion.height;
        if (tableBottom - lastBoundary > 5) {
            rows.push({
                yMin: lastBoundary,
                yMax: tableBottom
            });
        }
    }
    
    // Initialize 2D array
    const cells = rows.map(() => columns.map(() => []));
    
    // Find description column index
    const descriptionColIndex = columns.findIndex(col => col.type === 'description');
    
    // Assign words to cells
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const assignedWords = new Set();
        
        // Pass 1: Assign to structured columns using STRICT header boundaries
        // Word center must be within headerXMin to headerXMax (original header word position)
        for (const word of words) {
            // Skip words outside row bounds
            if (word.y < row.yMin || word.y >= row.yMax) continue;
            
            // Skip words outside table region horizontally
            if (word.x < tableRegion.x || word.x > (tableRegion.x + tableRegion.width)) {
                continue;
            }
            
            // Find column using STRICT header boundaries with small padding.
            // Narrow header words (e.g. "Date" at 16px) can be narrower than
            // their data (e.g. "07/03/23" at 36px). Padding ensures data whose
            // center falls just outside the header text still matches.
            const wordCenter = word.x + word.width / 2;
            const pad = RECTANGLE_CONFIG.STRICT_BOUNDARY_PADDING || 5;
            let colIndex = -1;
            
            for (let i = 0; i < columns.length; i++) {
                // Skip description column in pass 1
                if (i === descriptionColIndex) continue;
                
                // Use strict header boundaries with padding
                if (wordCenter >= (columns[i].headerXMin - pad) && wordCenter <= (columns[i].headerXMax + pad)) {
                    colIndex = i;
                    break;
                }
            }
            
            if (colIndex === -1) continue;
            
            // Assign to structured column
            cells[rowIndex][colIndex].push(word);
            assignedWords.add(word);
        }
        
        // Pass 2: Assign all remaining words to description column
        if (descriptionColIndex >= 0) {
            const unassignedWords = words.filter(word => {
                // Check if word is in this row
                if (word.y < row.yMin || word.y >= row.yMax) return false;
                
                // Check if word is in table region
                if (word.x < tableRegion.x || word.x > (tableRegion.x + tableRegion.width)) {
                    return false;
                }
                
                // Check if not already assigned
                return !assignedWords.has(word);
            });
            
            // Sort by Y position first (line order), then X position (left to right)
            // This maintains proper reading order across multiple lines
            unassignedWords.sort((a, b) => {
                const yDiff = a.y - b.y;
                if (Math.abs(yDiff) > RECTANGLE_CONFIG.WORD_Y_LINE_TOLERANCE) return yDiff;
                return a.x - b.x;
            });
            
            cells[rowIndex][descriptionColIndex].push(...unassignedWords);
        } else {
            // Fallback: No description column identified
            // Assign unassigned words using standard position matching
            for (const word of words) {
                if (word.y < row.yMin || word.y >= row.yMax) continue;
                if (assignedWords.has(word)) continue;
                
                const wordCenter = word.x + word.width / 2;
                for (let i = 0; i < columns.length; i++) {
                    if (wordCenter >= columns[i].xMin && wordCenter < columns[i].xMax) {
                        cells[rowIndex][i].push(word);
                        break;
                    }
                }
            }
        }
    }
    
    return cells;
}

/**
 * Extract text from each cell in a row, returning an array of uppercase strings
 * 
 * @param {Array} row - Array of cell word arrays (cells[rowIdx])
 * @returns {Array<string>} Uppercase text for each cell
 */
function extractRowText(row) {
    return row.map(cellWords => {
        // Sort words by Y then X for reading order
        const sorted = [...cellWords].sort((a, b) => {
            const yDiff = a.y - b.y;
            if (Math.abs(yDiff) > RECTANGLE_CONFIG.WORD_Y_LINE_TOLERANCE) return yDiff;
            return a.x - b.x;
        });
        return sorted.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
    });
}

/**
 * Determine whether a row of cell texts looks like a table header
 * 
 * Checks each cell text against known header keywords. A row is considered
 * a header if at least 2 cells contain recognized header keywords AND no
 * cell looks like a numeric date or dollar amount (which would indicate data).
 * 
 * @param {Array<string>} cellTexts - Uppercase text for each cell in the row
 * @returns {boolean} True if the row appears to be a header
 */
function isHeaderRow(cellTexts) {
    let headerKeywordHits = 0;
    let dataHits = 0;
    
    for (const text of cellTexts) {
        if (!text) continue;
        const lower = text.toLowerCase();
        
        // Check if this cell matches any header keyword
        const isKeyword = HEADER_KEYWORDS.some(kw => lower.includes(kw));
        if (isKeyword) headerKeywordHits++;
        
        // Check if this cell looks like a date (data, not header)
        const looksLikeDate = DATE_PATTERNS.some(p => p.test(text));
        
        // Check if this cell looks like a monetary amount (data, not header)
        const looksLikeAmount = /^-?\$?[\d,]+\.\d{2}$/.test(text.replace(/\s/g, ''));
        
        if (looksLikeDate || looksLikeAmount) dataHits++;
    }
    
    // Header if we found ≥2 keyword hits and no clear data cells
    return headerKeywordHits >= 2 && dataHits === 0;
}

/**
 * Parse with rectangle/line-based detection
 * 
 * @param {Array} pages - Pages data with word positions
 * @param {Array} rectangles - Rectangle drawing elements
 * @param {Array} horizontalLines - Horizontal line elements
 * @param {Array} verticalLines - Vertical line elements
 * @returns {Object} Parser result
 */
function parseWithRectangles(pages, rectangles, horizontalLines, verticalLines) {
    if (!pages || pages.length === 0) {
        return createResult(false, [], [], {}, 'No page data provided');
    }
    
    // Check if we have any graphic elements
    const hasGraphics = rectangles.length > 0 || 
                       horizontalLines.length > 0 || 
                       verticalLines.length > 0;
    
    if (!hasGraphics) {
        return createResult(false, [], [], { 
            rectangleParsingAttempted: true,
            noGraphicElements: true
        }, 'No rectangles or lines found - fallback to position-based parsing');
    }
    
    try {
        const allTransactions = [];
        let usedColumnInference = false;
        let totalTablesProcessed = 0;
        
        // ── Cross-page header memory ────────────────────────────────────
        // Multi-page bank statements typically show column headers only on
        // the first page. Continuation pages have the same table structure
        // but no header row. We remember the first successfully detected
        // headers + column count so we can reuse them on later pages.
        let rememberedHeaders = null;   // Array of header strings from first page
        let rememberedColCount = 0;     // Number of columns from first page
        
        // Process each page
        for (const page of pages) {
            // Detect table regions on this page
            const tableRegions = detectTableRegions(
                rectangles, 
                horizontalLines, 
                verticalLines, 
                page.pageNum
            );
            
            if (tableRegions.length === 0) continue;
            
            // Process each table region
            for (const region of tableRegions) {
                totalTablesProcessed++;
                
                let columnBoundaries = [];
                let rowBoundaries = [];
                
                // Get words in this table region for analysis
                const regionWords = page.words.filter(w => 
                    w.x >= region.x && 
                    w.x <= (region.x + region.width) &&
                    w.y >= region.y && 
                    w.y <= (region.y + region.height)
                );
                
                // Detect column and row boundaries based on region type
                if (region.type === 'cell-grid' && region.cellRectangles) {
                    // Strategy 1: Extract from cell rectangles
                    columnBoundaries = detectColumnBoundariesFromCellRectangles(
                        region.cellRectangles,
                        region
                    );
                    rowBoundaries = detectRowBoundariesFromCellRectangles(
                        region.cellRectangles,
                        region
                    );
                    
                    // Validate boundaries work for this table's words
                    if (!validateColumnBoundaries(columnBoundaries, regionWords, region)) {
                        // Boundaries don't work - recalculate from words
                        columnBoundaries = inferColumnBoundariesFromWords(regionWords, region, rowBoundaries);
                        usedColumnInference = true;
                    }
                } else {
                    // Strategy 2: Detect rows first (needed for better column inference)
                    const pageHLines = horizontalLines.filter(l => l.page === page.pageNum);
                    rowBoundaries = detectRowBoundariesFromLines(pageHLines, region);
                    
                    // Then detect columns
                    const pageVLines = verticalLines.filter(l => l.page === page.pageNum);
                    columnBoundaries = detectColumnBoundariesFromLines(pageVLines, region);
                    
                    // Validate vertical line boundaries
                    if (columnBoundaries.length > 0 && 
                        !validateColumnBoundaries(columnBoundaries, regionWords, region)) {
                        // Vertical lines exist but don't work well - recalculate
                        columnBoundaries = inferColumnBoundariesFromWords(regionWords, region, rowBoundaries);
                        usedColumnInference = true;
                    } else if (columnBoundaries.length === 0) {
                        // No vertical lines - infer from word positions
                        // Pass row boundaries for better row-by-row gap analysis
                        columnBoundaries = inferColumnBoundariesFromWords(regionWords, region, rowBoundaries);
                        usedColumnInference = true;
                    }
                }
                
                const columns = createColumnsFromBoundaries(columnBoundaries, region);
                
                // Assign words to cells
                const cells = assignWordsToCells(page.words, rowBoundaries, columns, region);
                
                if (cells.length === 0) continue;
                
                // ── Header Detection (multi-strategy) ──────────────────────
                // Strategy 1: Scan the first few cell rows for a header row.
                //   Some tables have a summary/title row before the real header.
                // Strategy 2: If no header found in cells, search page words
                //   above the first row boundary.  In line-grid tables the header
                //   text often sits between the table's top border and the first
                //   horizontal separator, so it's never captured as a cell row.
                // Strategy 3: If no header found on this page at all, reuse
                //   the headers from the first page (cross-page carry).
                
                let headerRowIdx = -1;
                const maxHeaderScan = Math.min(cells.length, 5);
                for (let scanIdx = 0; scanIdx < maxHeaderScan; scanIdx++) {
                    const scanTexts = extractRowText(cells[scanIdx]);
                    if (isHeaderRow(scanTexts)) {
                        headerRowIdx = scanIdx;
                        break;
                    }
                }
                
                // Build headers and determine the first data row index
                const headers = [];
                let dataStartIdx = 0;
                
                if (headerRowIdx >= 0) {
                    // Header found in cell rows -- use its text
                    const hRow = cells[headerRowIdx];
                    const hTexts = extractRowText(hRow);
                    dataStartIdx = headerRowIdx + 1;
                    
                    for (let colIdx = 0; colIdx < hRow.length; colIdx++) {
                        // Filter out very long strings that are clearly body text, not headers
                        const hText = hTexts[colIdx] || '';
                        headers.push(hText.length > 60 ? `COL_${colIdx}` : (hText || `COL_${colIdx}`));

                        // Update header boundaries based on actual header words
                        const cellWords = hRow[colIdx];
                        if (cellWords.length > 0 && columns[colIdx]) {
                            const minX = Math.min(...cellWords.map(w => w.x));
                            const maxX = Math.max(...cellWords.map(w => w.x + w.width));
                            columns[colIdx].headerXMin = minX;
                            columns[colIdx].headerXMax = maxX;
                        }
                    }
                } else {
                    // No header in cells -- try page words above the first cell row
                    const aboveHeaders = findHeadersAboveCells(
                        page.words, rowBoundaries, columns, region
                    );
                    
                    if (aboveHeaders) {
                        // Found header text above the cell grid
                        dataStartIdx = 0; // All cell rows are data
                        headers.push(...aboveHeaders);
                    } else if (rememberedHeaders && columns.length === rememberedColCount) {
                        // Strategy 3: No headers on this page -- reuse headers from
                        // the first page. This handles multi-page statements where
                        // the header row only appears on page 1.
                        dataStartIdx = 0;
                        headers.push(...rememberedHeaders);
                    } else {
                        // No headers found anywhere -- use generic COL_N names
                        dataStartIdx = 0;
                        for (let colIdx = 0; colIdx < columns.length; colIdx++) {
                            headers.push(`COL_${colIdx}`);
                        }
                    }
                }
                
                // Remember the first real headers for cross-page reuse
                if (!rememberedHeaders) {
                    const hasRealHeaders = headers.some(h => !/^COL_\d+$/.test(h));
                    if (hasRealHeaders) {
                        rememberedHeaders = [...headers];
                        rememberedColCount = columns.length;
                    }
                }
                
                // Convert cells to transactions (starting from dataStartIdx)
                for (let rowIdx = dataStartIdx; rowIdx < cells.length; rowIdx++) {
                    const row = cells[rowIdx];
                    const transaction = {};
                    
                    // Build transaction using actual column headers
                    for (let colIdx = 0; colIdx < row.length; colIdx++) {
                        const cellWords = row[colIdx];
                        
                        // Sort words by Y position first (line order), then X position (left to right)
                        // This maintains proper reading order across multiple lines within a cell
                        cellWords.sort((a, b) => {
                            const yDiff = a.y - b.y;
                            if (Math.abs(yDiff) > RECTANGLE_CONFIG.WORD_Y_LINE_TOLERANCE) return yDiff;
                            return a.x - b.x;
                        });
                        
                        // Join words and normalize whitespace
                        const cellText = cellWords.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
                        
                        // Use actual header name
                        const colName = headers[colIdx] || `COL_${colIdx}`;
                        transaction[colName] = cellText;
                    }
                    
                    // Only add if has meaningful content: at least 2 non-empty cells,
                    // or 1 cell with >3 characters. This filters out rows that have
                    // cell rectangles but no real data (border artifacts, spacer rows).
                    const nonEmptyCells = Object.values(transaction).filter(v => v && v.trim().length > 0);
                    const hasRealContent = nonEmptyCells.length >= 2 || 
                        nonEmptyCells.some(v => v.trim().length > 3);
                    
                    if (hasRealContent) {
                        allTransactions.push(transaction);
                    }
                }
            }
        }
        
        // Derive output headers from the first transaction's keys
        let outputHeaders = ['DATE', 'DESCRIPTION', 'AMOUNT']; // Default
        
        if (allTransactions.length > 0) {
            outputHeaders = Object.keys(allTransactions[0]);
        }
        
        // Filter out transactions whose keys don't align with the output headers.
        // This happens when multiple table regions have different column structures --
        // transactions from mismatched regions would produce empty CSV rows.
        const filteredTransactions = allTransactions.filter(tx => {
            return outputHeaders.some(h => {
                const v = tx[h];
                return v != null && String(v).trim().length > 0;
            });
        });
        
        // ── Quality gate ─────────────────────────────────────────────
        // Verify the extracted data looks like real transactions, not noise
        // from summary grids, fee tables, or miscellaneous page content.
        //
        // Check 1: Generic headers (COL_N) with poor data → reject
        // Check 2: Any cell with excessively long text (>300 chars) is a
        //          sign we captured paragraph text, not transaction cells.
        //          Real transaction cells (date, description, amount) are
        //          compact. If the majority of "transactions" contain such
        //          cells, the table region was likely non-transactional.
        
        const allGenericHeaders = outputHeaders.every(h => /^COL_\d+$/.test(h));
        if (allGenericHeaders && filteredTransactions.length > 0) {
            // Measure data quality: average number of non-empty cells per transaction
            const avgNonEmptyCells = filteredTransactions.reduce((sum, tx) => {
                return sum + Object.values(tx).filter(v => v && String(v).trim().length > 0).length;
            }, 0) / filteredTransactions.length;
            
            if (avgNonEmptyCells < 3 || filteredTransactions.length < 3) {
                return createResult(false, [], [], {
                    rectangleParsingAttempted: true,
                    noHeadersDetected: true
                }, 'Rectangle parser found table regions but could not identify transaction data - fallback to position-based parsing');
            }
        }
        
        // Check if extracted data resembles real transactions.
        // Real transactions have compact cells (dates, short descriptions,
        // amounts). If most "transactions" contain paragraph-length text
        // (>300 chars in any cell), the table region captured non-transactional
        // content (fee summaries, disclaimers, balance grids, etc.).
        const MAX_CELL_LENGTH = 300;
        const paragraphRows = filteredTransactions.filter(tx =>
            Object.values(tx).some(v => typeof v === 'string' && v.length > MAX_CELL_LENGTH)
        );
        if (paragraphRows.length > filteredTransactions.length * 0.5) {
            return createResult(false, [], [], {
                rectangleParsingAttempted: true,
                reason: 'Majority of rows contain paragraph-length text - likely non-transactional content'
            }, 'Rectangle parser captured non-transactional content - fallback to position-based parsing');
        }
        
        const metadata = {
            bank: 'unknown',
            statementType: 'generic',
            parserType: 'rectangle-based',
            rectanglesFound: rectangles.length,
            horizontalLinesFound: horizontalLines.length,
            verticalLinesFound: verticalLines.length,
            tablesProcessed: totalTablesProcessed,
            columnInferenceUsed: usedColumnInference,
            transactionCount: filteredTransactions.length
        };
        
        return createResult(
            filteredTransactions.length > 0,
            filteredTransactions,
            outputHeaders,
            metadata,
            filteredTransactions.length === 0 ? 'No transactions extracted from table regions' : null
        );
        
    } catch (error) {
        return createResult(false, [], [], {}, `Rectangle parsing error: ${error.message}`);
    }
}

export {
    parseWithRectangles,
    detectTableRegions,
    detectColumnBoundariesFromLines,
    detectColumnBoundariesFromCellRectangles,
    detectRowBoundariesFromCellRectangles,
    inferColumnBoundariesFromWords,
    findGapsInRow,
    validateColumnBoundaries,
    detectRowBoundariesFromLines,
    assignWordsToCells
};
