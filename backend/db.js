require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

// Schemas
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }
}, { timestamps: true });

const playerSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sport: { type: String, required: true },
    name: { type: String, required: true },
    role: String,
    location: String,
    availability: String,
    skill_level: String,
    total_runs: { type: Number, default: 0 },
    last_match_runs: { type: Number, default: 0 },
    total_wickets: { type: Number, default: 0 },
    last_match_wickets: { type: Number, default: 0 },
    highest_score: { type: Number, default: 0 },
    matches_played: { type: Number, default: 0 },
    total_balls_faced: { type: Number, default: 0 },
    current_match_runs: { type: Number, default: 0 },
    current_match_wickets: { type: Number, default: 0 },
    current_match_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', default: null },
    badminton_matches_played: { type: Number, default: 0 },
    badminton_wins: { type: Number, default: 0 },
    badminton_losses: { type: Number, default: 0 },
    last_match_points: { type: Number, default: 0 }
});

const teamSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sport: { type: String, required: true },
    team_name: { type: String, required: true },
    need: String,
    location: String,
    match_time: String,
    description: String
});

const matchSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sport: { type: String, required: true },
    team_name: { type: String, required: true },
    location: String,
    google_maps_link: String,
    match_date: Date,
    match_time: String,
    players_needed: Number,
    status: { type: String, default: 'open' }, // 'open', 'started', 'finished', 'timeout'
    score: { type: String, default: '0 - 0' },
    match_state: { type: mongoose.Schema.Types.Mixed, default: null },
    overs: { type: Number, default: null },
    team_a_captain_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    team_b_captain_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

const matchPlayerSchema = new mongoose.Schema({
    match_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    team: { type: String, default: 'B' }
}, { timestamps: { createdAt: 'joined_at', updatedAt: false } });

matchPlayerSchema.index({ match_id: 1, user_id: 1 }, { unique: true });

const ratingSchema = new mongoose.Schema({
    match_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
    rater_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ratee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, min: 1, max: 5, required: true }
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

ratingSchema.index({ match_id: 1, rater_id: 1, ratee_id: 1 }, { unique: true });

const playerMatchStatSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    match_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
    sport: { type: String, required: true },
    runs: { type: Number, default: 0 },
    wickets: { type: Number, default: 0 },
    balls_faced: { type: Number, default: 0 },
    points: { type: Number, default: 0 },
    is_not_out: { type: Boolean, default: false }
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

playerMatchStatSchema.index({ user_id: 1, match_id: 1, sport: 1 }, { unique: true });

// Models
const User = mongoose.model('User', userSchema);
const Player = mongoose.model('Player', playerSchema);
const Team = mongoose.model('Team', teamSchema);
const Match = mongoose.model('Match', matchSchema);
const MatchPlayer = mongoose.model('MatchPlayer', matchPlayerSchema);
const Rating = mongoose.model('Rating', ratingSchema);
const PlayerMatchStat = mongoose.model('PlayerMatchStat', playerMatchStatSchema);

async function initDB() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB is ready to go!');
        
        // Optionally create mock data if DB is empty
        const userCount = await User.countDocuments();
        if (userCount === 0) {
            console.log('First time setup: No mock data script configured for Mongoose yet.');
        }
    } catch (err) {
        console.error('Database setup error (Check your MongoDB URI):', err.message);
    }
}

module.exports = {
    initDB,
    User,
    Player,
    Team,
    Match,
    MatchPlayer,
    Rating,
    PlayerMatchStat
};