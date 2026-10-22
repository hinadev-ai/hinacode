package main

type procRow struct {
	pid       int32
	ppid      int32
	startedAt int64
}

// descendants returns the pids of root and every process below it, leaving out skip and its subtree.
// It returns nothing when no row matches root's pid and start time.
func descendants(rows []procRow, root identity, skip int32) map[int32]bool {
	children := make(map[int32][]procRow)
	var rootFound bool
	for _, r := range rows {
		if r.pid == root.pid && r.startedAt == root.startedAt {
			rootFound = true
			continue
		}
		children[r.ppid] = append(children[r.ppid], r)
	}
	if !rootFound {
		return nil
	}

	tree := map[int32]bool{root.pid: true}
	queue := []procRow{{pid: root.pid, startedAt: root.startedAt}}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range children[parent.pid] {
			// A child older than its parent belonged to an earlier process that had the same pid.
			if child.pid == skip || child.startedAt < parent.startedAt || tree[child.pid] {
				continue
			}
			tree[child.pid] = true
			queue = append(queue, child)
		}
	}
	return tree
}
