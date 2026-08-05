require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { initDB, User, Player, Team, Match, MatchPlayer, Rating, PlayerMatchStat } = require('./db');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database automatically on startup
initDB();

// Auto-start or timeout matches when their scheduled time arrives
setInterval(async () => {
    try {
        const now = new Date();
        const openMatches = await Match.find({ status: 'open' });
        
        for (let m of openMatches) {
            // Parse HH:MM AM/PM
            const [timeStr, modifier] = (m.match_time || '12:00 AM').split(' ');
            let [hours, minutes] = timeStr.split(':');
            hours = parseInt(hours, 10);
            if (modifier && modifier.toUpperCase() === 'PM' && hours !== 12) hours += 12;
            if (modifier && modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;
            
            const matchDateTime = new Date(m.match_date);
            matchDateTime.setHours(hours, parseInt(minutes, 10) || 0, 0, 0);

            if (matchDateTime <= now) {
                const totalTeamA = await MatchPlayer.countDocuments({ match_id: m._id, team: 'A' });
                const totalTeamB = await MatchPlayer.countDocuments({ match_id: m._id, team: { $in: ['B', null] } });

                if ((m.players_needed || 0) <= 0 && totalTeamA > 0 && totalTeamA === totalTeamB) {
                    m.status = 'started';
                } else {
                    m.status = 'timeout';
                }
                await m.save();
            }
        }
    } catch (err) {
        console.error('Error auto-processing matches:', err);
    }
}, 60000); // Check every minute
// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Session Middleware (MongoDB Store for Vercel, with fallback)
const sessionOptions = {
    secret: 'khel_re_super_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
    }
};

if (process.env.MONGODB_URI) {
    sessionOptions.store = MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        collectionName: 'sessions'
    });
}

app.use(session(sessionOptions));

// Make user available to all templates
app.use(async (req, res, next) => {
    if (req.session.user) {
        try {
            const ratings = await Rating.find({ ratee_id: req.session.user.id });
            if (ratings.length > 0) {
                const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
                req.session.user.avg_rating = (sum / ratings.length).toFixed(1);
            } else {
                req.session.user.avg_rating = null;
            }
        } catch (err) {
            console.error('Error fetching user avg rating in middleware', err);
        }
    }
    res.locals.user = req.session.user || null;
    next();
});

// Mock data file path
const matchPath = path.join(__dirname, '../public/data/matchmaking.json');

// Mount the API Router for the Flutter App
const apiRouter = require('./api');
app.use('/api', express.json(), apiRouter);

// Web Routes
app.get('/', async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        const matchCount = await Match.countDocuments();
        res.render('index', { 
            title: 'Khel Re - Find Your Team',
            userCount: userCount,
            matchCount: matchCount
        });
    } catch (err) {
        console.error(err);
        res.render('index', { 
            title: 'Khel Re - Find Your Team',
            userCount: 1200,
            matchCount: 340
        });
    }
});

app.get('/sport/:type', async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    if (sportType !== 'cricket' && sportType !== 'badminton') {
        return res.redirect('/');
    }
    
    try {
        const playersData = await Player.find({ sport: sportType }).lean();
        const teamsData = await Team.find({ sport: sportType }).lean();
        
        const matchesData = await Match.aggregate([
            { $match: { sport: sportType } },
            { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'host' } },
            { $unwind: { path: '$host', preserveNullAndEmptyArrays: true } },
            { $addFields: { host_name: '$host.name', id: '$_id' } },
            { $sort: { created_at: -1 } }
        ]);

        let joinedMatchIds = [];
        let userRatings = [];
        if (req.session.user) {
            const joined = await MatchPlayer.find({ user_id: req.session.user.id }).lean();
            joinedMatchIds = joined.map(j => j.match_id.toString());
            
            userRatings = await Rating.find({ rater_id: req.session.user.id }).lean();
        }

        const allJoinedPlayers = await MatchPlayer.aggregate([
            {
                $lookup: {
                    from: 'users',
                    localField: 'user_id',
                    foreignField: '_id',
                    as: 'user'
                }
            },
            { $unwind: '$user' },
            {
                $lookup: {
                    from: 'players',
                    let: { userId: '$user_id' },
                    pipeline: [
                        { $match: { $expr: { $and: [{ $eq: ['$user_id', '$$userId'] }, { $eq: ['$sport', sportType] }] } } }
                    ],
                    as: 'player'
                }
            },
            { $unwind: { path: '$player', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    match_id: 1,
                    team: 1,
                    user_id: '$user._id',
                    name: '$user.name',
                    total_runs: { $ifNull: ['$player.total_runs', 0] },
                    total_wickets: { $ifNull: ['$player.total_wickets', 0] }
                }
            }
        ]);

        const matchPlayersMap = {};
        allJoinedPlayers.forEach(p => {
            const mId = p.match_id.toString();
            if (!matchPlayersMap[mId]) {
                matchPlayersMap[mId] = [];
            }
            matchPlayersMap[mId].push({ 
                id: p.user_id.toString(), 
                name: p.name, 
                team: p.team || 'B',
                total_runs: p.total_runs || 0,
                total_wickets: p.total_wickets || 0
            });
        });

        const avgRatings = await Rating.aggregate([
            { $group: { _id: '$ratee_id', avg_rating: { $avg: '$rating' }, count: { $sum: 1 } } }
        ]);
        const playerAvgRatings = {};
        avgRatings.forEach(r => {
            playerAvgRatings[r._id.toString()] = { avg: r.avg_rating.toFixed(1), count: r.count };
        });

        let topPlayers = [];
        let currentUserProfile = null;
        if (sportType === 'cricket') {
            topPlayers = await Player.aggregate([
                { $match: { sport: 'cricket', total_runs: { $gt: 0 } } },
                { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
                { $unwind: '$user' },
                { $addFields: { name: '$user.name' } },
                { $sort: { total_runs: -1 } },
                { $limit: 10 }
            ]);

            if (req.session.user) {
                const myStats = await Player.find({ user_id: req.session.user.id, sport: 'cricket' }).lean();
                if (myStats.length > 0) {
                    currentUserProfile = myStats[0];
                    currentUserProfile.id = currentUserProfile._id.toString();
                    currentUserProfile.live_runs = currentUserProfile.current_match_id ? currentUserProfile.current_match_runs : 0;
                    currentUserProfile.live_wickets = currentUserProfile.current_match_id ? currentUserProfile.current_match_wickets : 0;
                    
                    const history = await PlayerMatchStat.aggregate([
                        { $match: { user_id: new mongoose.Types.ObjectId(req.session.user.id), sport: 'cricket' } },
                        { $lookup: { from: 'matches', localField: 'match_id', foreignField: '_id', as: 'match' } },
                        { $unwind: '$match' },
                        { $sort: { created_at: -1 } },
                        { $limit: 5 },
                        { $project: { runs: 1, wickets: 1, balls_faced: 1, team_name: '$match.team_name', match_date: '$match.match_date' } }
                    ]);
                    currentUserProfile.match_history = history;
                }
            }
        }

        res.render('sport', {
            title: `Khel Re - ${sportType.charAt(0).toUpperCase() + sportType.slice(1)} Matchmaking`,
            sportName: sportType,
            players: playersData.map(p => ({...p, id: p._id.toString()})),
            teams: teamsData.map(t => ({...t, id: t._id.toString()})),
            matches: matchesData.map(m => ({...m, id: (m.id || m._id).toString()})),
            joinedMatchIds: joinedMatchIds,
            matchPlayersMap: matchPlayersMap,
            userRatings: userRatings,
            playerAvgRatings: playerAvgRatings,
            finishedMatchId: req.query.finished || null,
            topPlayers: topPlayers,
            currentUserProfile: currentUserProfile
        });
    } catch (err) {
        console.error('Database query error:', err);
        res.status(500).send('Error loading matchmaking data from database.');
    }
});

app.post('/sport/:type/new', express.urlencoded({ extended: true }), async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    
    if (!req.session.user) {
        return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("You must be logged in to post a new game!")}&type=error`);
    }

    const { teamName, location, googleMapsLink, date, time, playersNeeded, overs } = req.body;
    const userId = req.session.user.id;

    try {
        const match = await Match.create({
            user_id: userId,
            sport: sportType,
            team_name: teamName,
            location,
            google_maps_link: googleMapsLink,
            match_date: date,
            match_time: time,
            players_needed: Math.max(0, parseInt(playersNeeded) - 1),
            overs: overs || null
        });
        
        await MatchPlayer.create({ match_id: match._id, user_id: userId, team: 'A' });
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Your game has been successfully posted!")}&type=success`);
    } catch (err) {
        console.error('Error saving match:', err);
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Error saving your match to the database.")}&type=error`);
    }
});

app.post('/sport/:type/rate/:matchId', express.json(), async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: 'You must be logged in to rate.' });
    }

    const { matchId } = req.params;
    const { ratee_id, rating } = req.body;
    const rater_id = req.session.user.id;

    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: 'Invalid rating.' });
    }

    try {
        await Rating.findOneAndUpdate(
            { match_id: matchId, rater_id, ratee_id },
            { rating },
            { upsert: true, new: true }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error saving rating:', err);
        res.status(500).json({ success: false, message: 'Server error saving rating.' });
    }
});

app.post('/sport/:type/join/:matchId', express.urlencoded({ extended: true }), async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    const matchId = req.params.matchId;

    if (!req.session.user) {
        return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("You must be logged in to join a team!")}&type=error`);
    }

    const userId = req.session.user.id;

    try {
        const existing = await MatchPlayer.findOne({ match_id: matchId, user_id: userId });
        if (existing) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("You have already joined this team!")}&type=success`);
        }

        if (sportType === 'cricket') {
            const pCount = await MatchPlayer.countDocuments({ match_id: matchId });
            if (pCount >= 22) {
                return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Match is full! Cricket allows a maximum of 11 players per team.")}&type=error`);
            }
        }

        const countA = await MatchPlayer.countDocuments({ match_id: matchId, team: 'A' });
        const countB = await MatchPlayer.countDocuments({ match_id: matchId, team: 'B' });
        const assignedTeam = (countA <= countB) ? 'A' : 'B';

        await MatchPlayer.create({ match_id: matchId, user_id: userId, team: assignedTeam });
        await Match.updateOne({ _id: matchId, players_needed: { $gt: 0 } }, { $inc: { players_needed: -1 } });

        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("You have successfully joined the team!")}&type=success`);
    } catch (err) {
        console.error('Error joining match:', err);
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Error joining the team.")}&type=error`);
    }
});

app.post('/sport/:type/edit-capacity/:matchId', express.urlencoded({ extended: true }), async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    const matchId = req.params.matchId;
    const capacity = parseInt(req.body.capacity);

    if (!req.session.user || isNaN(capacity)) {
        return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Invalid request.")}&type=error`);
    }

    try {
        const match = await Match.findById(matchId);
        if (!match || match.user_id.toString() !== req.session.user.id.toString()) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Unauthorized! Only the host can edit match size.")}&type=error`);
        }

        const joinedCount = await MatchPlayer.countDocuments({ match_id: matchId });
        let newPlayersNeeded = capacity - joinedCount;
        if (newPlayersNeeded < 0) newPlayersNeeded = 0;

        match.players_needed = newPlayersNeeded;
        await match.save();
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Match size updated successfully!")}&type=success`);
    } catch (err) {
        console.error('Error updating capacity:', err);
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Error updating match size.")}&type=error`);
    }
});

app.post('/sport/:type/team-formation/:matchId', express.urlencoded({ extended: true }), async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    const matchId = req.params.matchId;

    if (!req.session.user) {
        return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("You must be logged in!")}&type=error`);
    }

    try {
        const match = await Match.findById(matchId);
        if (!match || match.user_id.toString() !== req.session.user.id.toString()) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Unauthorized! Only the host can set teams.")}&type=error`);
        }

        let teamACaptain = null;
        let teamBCaptain = null;
        
        let countA = 0;
        let countB = 0;
        let teamAssignments = [];

        for (const [key, value] of Object.entries(req.body)) {
            if (key === 'team_a_captain') {
                teamACaptain = value || null;
            } else if (key === 'team_b_captain') {
                teamBCaptain = value || null;
            } else if (key.startsWith('team_')) {
                const userId = key.split('_')[1];
                const team = (value === 'A') ? 'A' : 'B';
                teamAssignments.push({ userId, team });
                if (team === 'A') countA++;
                if (team === 'B') countB++;
            }
        }

        if (sportType === 'cricket' && (countA > 11 || countB > 11)) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Cricket teams cannot have more than 11 players each!")}&type=error`);
        }

        for (const assignment of teamAssignments) {
            await MatchPlayer.updateOne(
                { match_id: matchId, user_id: assignment.userId },
                { $set: { team: assignment.team } }
            );
        }

        match.team_a_captain_id = teamACaptain;
        match.team_b_captain_id = teamBCaptain;
        await match.save();

        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Teams saved successfully!")}&type=success`);
    } catch (err) {
        console.error('Error saving teams:', err);
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Error saving teams.")}&type=error`);
    }
});

app.post('/sport/:type/start/:matchId', express.urlencoded({ extended: true }), async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    const matchId = req.params.matchId;

    if (!req.session.user) {
        return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("You must be logged in!")}&type=error`);
    }

    try {
        const match = await Match.findById(matchId);
        if (!match || match.user_id.toString() !== req.session.user.id.toString()) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Unauthorized! Only the host can start the match.")}&type=error`);
        }

        const totalTeamA = await MatchPlayer.countDocuments({ match_id: matchId, team: 'A' });
        const totalTeamB = await MatchPlayer.countDocuments({ match_id: matchId, team: { $in: ['B', null] } });

        if (totalTeamA === 0 || totalTeamB === 0) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Cannot start match. Both teams must have at least 1 player.")}&type=error`);
        }

        if (totalTeamA !== totalTeamB) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Cannot start match! Team A and Team B must have an equal number of players.")}&type=error`);
        }

        match.status = 'started';
        await match.save();
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Match started successfully!")}&type=success`);
    } catch (err) {
        console.error('Error starting match:', err);
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Error starting match.")}&type=error`);
    }
});

app.post('/sport/:type/finish/:matchId', express.urlencoded({ extended: true }), async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    const matchId = req.params.matchId;

    if (!req.session.user) {
        return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("You must be logged in!")}&type=error`);
    }

    try {
        const match = await Match.findById(matchId);
        if (!match || match.user_id.toString() !== req.session.user.id.toString()) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Unauthorized! Only the host can finish the match.")}&type=error`);
        }

        match.status = 'played';
        await match.save();
        
        if (req.query.redirect === 'scorecard') {
            res.redirect(`/sport/${sportType}/scorecard/${matchId}?finished=true`);
        } else {
            res.redirect(`/sport/${sportType}?finished=${matchId}`);
        }
    } catch (err) {
        console.error('Error finishing match:', err);
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Error finishing match.")}&type=error`);
    }
});

app.post('/sport/:type/score/:matchId', express.urlencoded({ extended: true }), async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    const matchId = req.params.matchId;
    const { score } = req.body;

    if (!req.session.user) {
        return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("You must be logged in to update the score!")}&type=error`);
    }

    const userId = req.session.user.id;

    try {
        const match = await Match.findById(matchId);
        if (!match) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Match not found.")}&type=success`);
        }
        
        let isAuthorized = (match.user_id.toString() === userId.toString());
        
        if (!isAuthorized) {
            const joined = await MatchPlayer.findOne({ match_id: matchId, user_id: userId });
            if (joined) isAuthorized = true;
        }

        if (!isAuthorized) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Unauthorized! Only the host or team players can update the score.")}&type=error`);
        }

        let newScoreStr = score;
        if (sportType === 'cricket' && req.body.cricketDelta && req.body.cricketDelta !== '0,0,0|0,0,0') {
            const parseCricket = (str) => {
                if (!str || str === '0 - 0') return { r: 0, w: 0, o: 0, b: 0 };
                const m = str.match(/^(\d+)(?:\/(\d+))?(?:\s*\(([\d.]+)\))?$/);
                if (!m) return { r: 0, w: 0, o: 0, b: 0 };
                return { r: parseInt(m[1])||0, w: parseInt(m[2])||0, o: parseInt((m[3]||'0').split('.')[0])||0, b: parseInt((m[3]||'0').split('.')[1])||0 };
            };
            const [deltaA, deltaB] = req.body.cricketDelta.split('|');
            const [drA, dwA, dbA] = deltaA.split(',').map(Number);
            const [drB, dwB, dbB] = deltaB.split(',').map(Number);
            
            const currentScore = match.score || '0 - 0';
            const parts = currentScore.split('-').map(s => s.trim());
            let tA = parseCricket(parts[0]);
            let tB = parseCricket(parts[1]);
            
            const updateTeam = (t, dr, dw, db) => {
                t.r = Math.max(0, t.r + dr);
                t.w = Math.max(0, Math.min(10, t.w + dw));
                let totalBalls = Math.max(0, t.o * 6 + t.b + db);
                t.o = Math.floor(totalBalls / 6);
                t.b = totalBalls % 6;
            };
            updateTeam(tA, drA, dwA, dbA);
            updateTeam(tB, drB, dwB, dbB);
            
            newScoreStr = `${tA.r}/${tA.w} (${tA.o}.${tA.b}) - ${tB.r}/${tB.w} (${tB.o}.${tB.b})`;

            let matchStateObj = match.match_state || {};
            if (!matchStateObj.player_stats) matchStateObj.player_stats = {};

            if (req.body.playerStatsDelta) {
                try {
                    const pDelta = JSON.parse(req.body.playerStatsDelta);
                    for (const pid in pDelta) {
                        if (!matchStateObj.player_stats[pid]) {
                            matchStateObj.player_stats[pid] = { runs: 0, wickets: 0, balls_faced: 0 };
                        }
                        matchStateObj.player_stats[pid].runs = Math.max(0, (matchStateObj.player_stats[pid].runs || 0) + (pDelta[pid].runs || 0));
                        matchStateObj.player_stats[pid].wickets = Math.max(0, (matchStateObj.player_stats[pid].wickets || 0) + (pDelta[pid].wickets || 0));
                        matchStateObj.player_stats[pid].balls_faced = Math.max(0, (matchStateObj.player_stats[pid].balls_faced || 0) + (pDelta[pid].balls_faced || 0));
                    }
                } catch (e) {
                    console.error('Failed to parse playerStatsDelta', e);
                }
            }

            match.score = newScoreStr;
            match.match_state = matchStateObj;
            match.markModified('match_state');
            await match.save();

            if (req.body.playerStatsDelta) {
                try {
                    const pDelta = JSON.parse(req.body.playerStatsDelta);
                    for (const uid in pDelta) {
                        const dr = pDelta[uid].runs || 0;
                        const dw = pDelta[uid].wickets || 0;
                        if (dr !== 0 || dw !== 0) {
                            const user = await User.findById(uid);
                            if (user) {
                                await Player.findOneAndUpdate(
                                    { user_id: uid, sport: 'cricket' },
                                    { 
                                        $setOnInsert: { name: user.name, total_runs: 0, total_wickets: 0, highest_score: 0, matches_played: 0, total_balls_faced: 0, last_match_runs: 0, last_match_wickets: 0 },
                                        $inc: { current_match_runs: dr, current_match_wickets: dw },
                                        $set: { current_match_id: matchId }
                                    },
                                    { upsert: true }
                                );
                            }
                        }
                    }
                } catch (e) { console.error('Failed to update current_match stats', e); }
            }
        } else if (sportType !== 'cricket' && req.body.scoreDelta && req.body.scoreDelta !== '0,0') {
            const [deltaA, deltaB] = req.body.scoreDelta.split(',').map(Number);
            const currentScore = match.score || '0 - 0';
            let [currA, currB] = currentScore.split('-').map(s => parseInt(s.trim()) || 0);
            currA = Math.max(0, currA + deltaA);
            currB = Math.max(0, currB + deltaB);
            newScoreStr = `${currA} - ${currB}`;
            
            match.score = newScoreStr;
            await match.save();
        } else {
            match.score = newScoreStr;
            await match.save();
        }
        
        if (req.query.redirect === 'scorecard') {
            res.redirect(`/sport/${sportType}/scorecard/${matchId}`);
        } else {
            res.redirect(`/sport/${sportType}`);
        }
    } catch (err) {
        console.error('Error updating score:', err);
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Error updating score.")}&type=error`);
    }
});

app.get('/sport/:type/scorecard/:matchId', async (req, res) => {
    const sportType = req.params.type.toLowerCase();
    const matchId = req.params.matchId;

    try {
        const matches = await Match.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(matchId) } },
            { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'host' } },
            { $unwind: { path: '$host', preserveNullAndEmptyArrays: true } },
            { $addFields: { host_name: '$host.name', id: '$_id' } }
        ]);

        if (matches.length === 0) {
            return res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Match not found.")}&type=success`);
        }

        const match = matches[0];
        
        let canEditScore = false;
        let matchState = match.match_state || {};
        
        if (req.session.user && match.user_id.toString() === req.session.user.id.toString()) {
            canEditScore = true;
        }

        const players = await MatchPlayer.aggregate([
            { $match: { match_id: new mongoose.Types.ObjectId(matchId) } },
            { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'user' } },
            { $unwind: '$user' },
            { 
                $lookup: { 
                    from: 'players', 
                    let: { userId: '$user_id' },
                    pipeline: [ { $match: { $expr: { $and: [ { $eq: ['$user_id', '$$userId'] }, { $eq: ['$sport', sportType] } ] } } } ],
                    as: 'player' 
                } 
            },
            { $unwind: { path: '$player', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    name: '$user.name',
                    id: '$user._id',
                    team: 1,
                    total_runs: { $ifNull: ['$player.total_runs', 0] },
                    total_wickets: { $ifNull: ['$player.total_wickets', 0] },
                    last_match_runs: { $ifNull: ['$player.last_match_runs', 0] },
                    last_match_wickets: { $ifNull: ['$player.last_match_wickets', 0] },
                    highest_score: { $ifNull: ['$player.highest_score', 0] },
                    matches_played: { $ifNull: ['$player.matches_played', 0] },
                    total_balls_faced: { $ifNull: ['$player.total_balls_faced', 0] }
                }
            }
        ]);

        const hostName = match.host_name || 'Anonymous';
        const teamAPlayers = [];
        const teamBPlayers = [];
        const teamAPlayerObjs = [];
        const teamBPlayerObjs = [];

        players.forEach(p => {
            p.id = p.id.toString();
            if (p.team === 'A') {
                teamAPlayers.push(p.name);
                teamAPlayerObjs.push(p);
            } else {
                teamBPlayers.push(p.name);
                teamBPlayerObjs.push(p);
            }
            if (req.session.user && p.id === req.session.user.id.toString()) {
                canEditScore = true;
            }
        });

        res.render(`${sportType}-score`, {
            title: `Khel Re - ${sportType.charAt(0).toUpperCase() + sportType.slice(1)} Scorecard`,
            sportName: sportType,
            match: { ...match, id: match._id.toString() },
            hostName: hostName,
            teamAPlayers: teamAPlayers,
            teamBPlayers: teamBPlayers,
            teamAPlayerObjs: teamAPlayerObjs,
            teamBPlayerObjs: teamBPlayerObjs,
            matchState: matchState,
            canEditScore: canEditScore,
            isFinished: req.query.finished === 'true' || match.status === 'played' || match.status === 'finished'
        });
    } catch (err) {
        console.error('Error loading scorecard:', err);
        res.redirect(`/sport/${sportType}?msg=${encodeURIComponent("Error loading scorecard.")}&type=error`);
    }
});

app.post('/sport/cricket/roles/:matchId', express.json(), async (req, res) => {
    const matchId = req.params.matchId;
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    try {
        const match = await Match.findById(matchId);
        if (!match) return res.status(404).json({ success: false, message: 'Match not found' });
        
        let isAuthorized = (match.user_id.toString() === req.session.user.id.toString());
        
        if (!isAuthorized) {
            const joined = await MatchPlayer.findOne({ match_id: matchId, user_id: req.session.user.id });
            if (joined) isAuthorized = true;
        }

        if (!isAuthorized) return res.status(403).json({ success: false, message: 'Unauthorized' });

        const mergedState = Object.assign({}, match.match_state || {}, req.body.matchState || {});
        match.match_state = mergedState;
        match.markModified('match_state');
        await match.save();
        
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving roles:', err);
        res.status(500).json({ success: false });
    }
});

app.post('/sport/cricket/player-stats/:matchId', express.urlencoded({ extended: true }), async (req, res) => {
    const matchId = req.params.matchId;
    if (!req.session.user) return res.redirect('/sport/cricket');

    try {
        const match = await Match.findById(matchId);
        if (!match || match.user_id.toString() !== req.session.user.id.toString()) {
            return res.redirect(`/sport/cricket?msg=${encodeURIComponent("Unauthorized")}&type=error`);
        }

        const matchStateObj = match.match_state || {};
        const playerStats = matchStateObj.player_stats || {};

        const matchPlayers = await MatchPlayer.find({ match_id: matchId }).lean();

        for (const mp of matchPlayers) {
            const uid = mp.user_id.toString();
            const stats = playerStats[uid] || { runs: 0, wickets: 0, balls_faced: 0 };
            const runs = Math.max(0, parseInt(stats.runs) || 0);
            const wickets = Math.max(0, parseInt(stats.wickets) || 0);
            const ballsFaced = Math.max(0, parseInt(stats.balls_faced) || 0);

            const user = await User.findById(uid);
            if (user) {
                await Player.findOneAndUpdate(
                    { user_id: uid, sport: 'cricket' },
                    { 
                        $setOnInsert: { name: user.name, total_runs: 0, total_wickets: 0, highest_score: 0, matches_played: 0, total_balls_faced: 0, last_match_runs: 0, last_match_wickets: 0 }
                    },
                    { upsert: true }
                );

                await PlayerMatchStat.findOneAndUpdate(
                    { user_id: uid, match_id: matchId, sport: 'cricket' },
                    { runs, wickets, balls_faced: ballsFaced },
                    { upsert: true }
                );

                await Player.findOneAndUpdate(
                    { user_id: uid, sport: 'cricket' },
                    {
                        $inc: {
                            total_runs: runs,
                            total_wickets: wickets,
                            total_balls_faced: ballsFaced,
                            matches_played: 1
                        },
                        $set: {
                            last_match_runs: runs,
                            last_match_wickets: wickets,
                            current_match_runs: 0,
                            current_match_wickets: 0,
                            current_match_id: null
                        },
                        $max: {
                            highest_score: runs
                        }
                    }
                );
            }
        }

        match.status = 'finished';
        await match.save();
        
        res.redirect(`/sport/cricket/scorecard/${matchId}?finished=true`);
    } catch (err) {
        console.error('Error saving player stats:', err);
        res.redirect('/sport/cricket');
    }
});

app.post('/sport/badminton/player-stats/:matchId', express.urlencoded({ extended: true }), async (req, res) => {
    const matchId = req.params.matchId;
    if (!req.session.user) return res.redirect('/sport/badminton');

    try {
        const match = await Match.findById(matchId);
        if (!match || match.user_id.toString() !== req.session.user.id.toString()) {
            return res.redirect(`/sport/badminton?msg=${encodeURIComponent("Unauthorized")}&type=error`);
        }

        let scoreA, scoreB;
        if (req.body.scoreA !== undefined && req.body.scoreB !== undefined) {
            scoreA = Math.max(0, parseInt(req.body.scoreA) || 0);
            scoreB = Math.max(0, parseInt(req.body.scoreB) || 0);
        } else {
            const dbScore = match.score || '0 - 0';
            const parts = dbScore.split('-').map(s => parseInt(s.trim()) || 0);
            scoreA = parts[0] || 0;
            scoreB = parts[1] || 0;
        }

        match.score = `${scoreA} - ${scoreB}`;

        const winner = scoreA > scoreB ? 'A' : (scoreB > scoreA ? 'B' : 'draw');

        const matchPlayers = await MatchPlayer.find({ match_id: matchId }).lean();

        for (const mp of matchPlayers) {
            const uid = mp.user_id.toString();
            const teamPoints = mp.team === 'A' ? scoreA : scoreB;
            const isWin = (winner === mp.team) ? 1 : 0;
            const isLoss = (winner !== mp.team && winner !== 'draw') ? 1 : 0;

            const user = await User.findById(uid);
            if (user) {
                await Player.findOneAndUpdate(
                    { user_id: uid, sport: 'badminton' },
                    { 
                        $setOnInsert: { name: user.name, total_runs: 0, total_wickets: 0, highest_score: 0, matches_played: 0, total_balls_faced: 0, last_match_runs: 0, last_match_wickets: 0, current_match_runs: 0, current_match_wickets: 0, badminton_matches_played: 0, badminton_wins: 0, badminton_losses: 0, last_match_points: 0 }
                    },
                    { upsert: true }
                );

                await PlayerMatchStat.findOneAndUpdate(
                    { user_id: uid, match_id: matchId, sport: 'badminton' },
                    { runs: 0, wickets: 0, balls_faced: 0, points: teamPoints },
                    { upsert: true }
                );

                await Player.findOneAndUpdate(
                    { user_id: uid, sport: 'badminton' },
                    { 
                        $inc: { badminton_matches_played: 1, badminton_wins: isWin, badminton_losses: isLoss },
                        $set: { last_match_points: teamPoints }
                    }
                );
            }
        }

        match.status = 'finished';
        await match.save();

        res.redirect(`/sport/badminton/scorecard/${matchId}?finished=true`);
    } catch (err) {
        console.error('Error saving badminton player stats:', err);
        res.redirect(`/sport/badminton?msg=${encodeURIComponent("Error finishing match: " + err.message)}&type=error`);
    }
});


app.post('/signup', express.urlencoded({ extended: true }), async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const user = await User.create({ name, email, password });
        req.session.user = { id: user._id.toString(), name: user.name };
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.redirect(`/?msg=${encodeURIComponent("Error creating account. Email might already exist.")}&type=error`);
    }
});

app.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email, password });
        if (user) {
            req.session.user = { id: user._id.toString(), name: user.name };
            res.redirect('/');
        } else {
            res.redirect(`/?msg=${encodeURIComponent("Invalid email or password!")}&type=error`);
        }
    } catch (err) {
        console.error(err);
        res.redirect(`/?msg=${encodeURIComponent("Error logging in.")}&type=error`);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

module.exports = app;
