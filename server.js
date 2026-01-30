const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));

// 방 데이터 저장
const rooms = new Map();

// 사용자 색상 팔레트
const COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
    '#BB8FCE', '#85C1E9', '#F8B500', '#00CED1'
];

io.on('connection', (socket) => {
    console.log('사용자 연결:', socket.id);
    
    let currentRoom = null;
    let userName = null;
    let userColor = null;
    
    // 방 참가
    socket.on('join-room', (data) => {
        const { roomId, name } = data;
        currentRoom = roomId;
        userName = name || `플레이어${Math.floor(Math.random() * 1000)}`;
        
        socket.join(roomId);
        
        // 방이 없으면 생성
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                pieces: {},       // 조각 상태 (위치, 그룹 등)
                groups: {},       // 그룹 정보
                image: null,      // 이미지 데이터
                puzzleConfig: null, // 퍼즐 설정
                users: new Map(), // 접속한 사용자들
                dragging: {}      // 현재 드래그 중인 조각
            });
        }
        
        const room = rooms.get(roomId);
		
		if (room.image) {
			socket.emit('image-loaded', {
				image: room.image,
				puzzleConfig: room.puzzleConfig,
				uploadedBy: room.uploadedBy,
				// 셔플된 상태인지 확인하기 위해 현재 조각들 위치 정보도 보냄
				currentPositions: room.groups 
			});
		}
        
        // 사용자별 고유 색상 할당
        userColor = COLORS[room.users.size % COLORS.length];
        room.users.set(socket.id, { 
            name: userName, 
            color: userColor,
            id: socket.id 
        });
        
        // 새 사용자에게 현재 상태 전송
        socket.emit('room-state', {
            pieces: room.pieces,
            groups: room.groups,
            image: room.image,
            puzzleConfig: room.puzzleConfig,
            users: Array.from(room.users.values()),
            yourColor: userColor,
            yourId: socket.id
        });
        
        // 다른 사용자들에게 새 사용자 알림
        socket.to(roomId).emit('user-joined', {
            id: socket.id,
            name: userName,
            color: userColor,
            users: Array.from(room.users.values())
        });
        
        console.log(`${userName} 님이 방 ${roomId}에 입장 (총 ${room.users.size}명)`);
    });
    
    // 이미지 업로드 (Base64)
    socket.on('upload-image', (data) => {
		if (currentRoom && rooms.has(currentRoom)) {
			const room = rooms.get(currentRoom);
			room.image = data.image;
			room.puzzleConfig = data.puzzleConfig;
			room.uploadedBy = userName;
			room.groups = {}; // 새 이미지이므로 위치 초기화

			// 방 전체에 알림
			io.to(currentRoom).emit('image-loaded', data);
		}
        
        console.log(`${userName} 님이 이미지 업로드 (방: ${currentRoom})`);
    });
    
    // 퍼즐 초기화 (조각 위치 설정)
    socket.on('init-pieces', (data) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        room.pieces = data.pieces;
        room.groups = data.groups;
        
        // 다른 사용자들에게 전송
        socket.to(currentRoom).emit('pieces-initialized', {
            pieces: data.pieces,
            groups: data.groups
        });
    });
    
    // 조각 드래그 시작
    socket.on('drag-start', (data) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        // 이미 다른 사람이 드래그 중인지 확인
        if (room.dragging[data.groupId] && room.dragging[data.groupId] !== socket.id) {
            socket.emit('drag-denied', { groupId: data.groupId });
            return;
        }
        
        room.dragging[data.groupId] = socket.id;
        
        socket.to(currentRoom).emit('piece-drag-start', {
            groupId: data.groupId,
            userId: socket.id,
            userName: userName,
            userColor: userColor
        });
    });
    
    // 조각 이동 (실시간)
    socket.on('drag-move', (data) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        // 권한 확인
        if (room.dragging[data.groupId] !== socket.id) return;
        
        // 다른 사용자들에게 전송
        socket.to(currentRoom).emit('piece-moved', {
            groupId: data.groupId,
            x: data.x,
            y: data.y,
            userId: socket.id
        });
    });
    
    // 조각 드래그 종료 (스냅/병합 포함)
    socket.on('drag-end', (data) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        delete room.dragging[data.groupId];
        
        // 그룹 상태 업데이트
        if (data.updatedGroups) {
            room.groups = data.updatedGroups;
        }
        if (data.updatedPieces) {
            room.pieces = data.updatedPieces;
        }
        
        socket.to(currentRoom).emit('piece-drag-end', {
            groupId: data.groupId,
            x: data.x,
            y: data.y,
            mergedWith: data.mergedWith,
            updatedGroups: data.updatedGroups,
            updatedPieces: data.updatedPieces,
            userId: socket.id
        });
        
        // 퍼즐 완성 체크
        if (data.isComplete) {
            io.to(currentRoom).emit('puzzle-complete', {
                completedBy: userName
            });
        }
    });
    
    // 커서 위치 공유 (선택적)
    socket.on('cursor-move', (data) => {
        if (!currentRoom) return;
        
        socket.to(currentRoom).emit('cursor-update', {
            userId: socket.id,
            userName: userName,
            userColor: userColor,
            x: data.x,
            y: data.y
        });
    });
    
    // 채팅 메시지
    socket.on('chat-message', (data) => {
        if (!currentRoom) return;
        
        io.to(currentRoom).emit('chat-message', {
            userId: socket.id,
            userName: userName,
            userColor: userColor,
            message: data.message,
            timestamp: Date.now()
        });
    });
    
    // 연결 해제
    socket.on('disconnect', () => {
        console.log('사용자 연결 해제:', socket.id);
        
        if (currentRoom && rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);
            room.users.delete(socket.id);
            
            // 드래그 중이던 조각 해제
            for (const [groupId, userId] of Object.entries(room.dragging)) {
                if (userId === socket.id) {
                    delete room.dragging[groupId];
                }
            }
            
            // 다른 사용자들에게 알림
            io.to(currentRoom).emit('user-left', {
                id: socket.id,
                name: userName,
                users: Array.from(room.users.values())
            });
            
            // 빈 방 정리 (5분 후)
            if (room.users.size === 0) {
                setTimeout(() => {
                    if (rooms.has(currentRoom) && rooms.get(currentRoom).users.size === 0) {
                        rooms.delete(currentRoom);
                        console.log(`빈 방 삭제: ${currentRoom}`);
                    }
                }, 5 * 60 * 1000);
            }
        }
    });
});

// 서버 시작
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🧩 퍼즐 서버 실행 중: http://localhost:${PORT}`);
});
