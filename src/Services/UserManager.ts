import type { ClientSession } from '@/Interfaces/IClient';

/**
 * UserManager - Optimized manager for connected users
 *
 * This class provides:
 * - ID access in O(1)
 * - GetAll in O(1)
 * - Optimized searches with native Array methods
 * - Perfect type-safety
 */
export class UserManager {
    private users = new Map<number, ClientSession>();
    private usersList: ClientSession[] = [];

    /**
     * Adds a connected user
     * @param profile The user profile to add
     * @returns true if successfully added, false if user has no ID
     */
    add(profile: ClientSession): boolean {
        if (!profile.user?.ID) {
            return false;
        }

        const userId = profile.user.ID;

        // If user already exists, update it
        if (this.users.has(userId)) {
            this.remove(userId);
        }

        this.users.set(userId, profile);
        this.usersList.push(profile);
        return true;
    }

    /**
     * Removes a connected user
     * @param userId The ID of the user to remove
     * @returns true if successfully removed, false if not found
     */
    remove(userId: number): boolean {
        const profile = this.users.get(userId);
        if (!profile) {
            return false;
        }

        this.users.delete(userId);
        const index = this.usersList.findIndex((p) => p.user?.ID === userId);
        if (index > -1) {
            this.usersList.splice(index, 1);
        }
        return true;
    }

    /**
     * Gets a user by their ID
     * @param userId The user ID
     * @returns The user profile or undefined if not found
     */
    getById(userId: number): ClientSession | undefined {
        return this.users.get(userId);
    }

    /**
     * Checks if a user is connected
     * @param userId The user ID
     * @returns true if the user is connected
     */
    has(userId: number): boolean {
        return this.users.has(userId);
    }

    /**
     * Gets all connected users
     * @returns Array of all connected profiles
     */
    getAll(): ClientSession[] {
        return this.usersList;
    }

    /**
     * Gets the number of connected users
     * @returns The number of connected users
     */
    count(): number {
        return this.users.size;
    }

    /**
     * Finds a user based on a predicate
     * @param predicate Search function
     * @returns The first matching profile or undefined
     */
    findBy(predicate: (profile: ClientSession) => boolean): ClientSession | undefined {
        return this.usersList.find(predicate);
    }

    /**
     * Filters users based on a predicate
     * @param predicate Filter function
     * @returns Array of matching profiles
     */
    filterBy(predicate: (profile: ClientSession) => boolean): ClientSession[] {
        return this.usersList.filter(predicate);
    }

    /**
     * Finds a user by email
     * @param email The email to search for
     * @returns The matching profile or undefined
     */
    findByEmail(email: string): ClientSession | undefined {
        return this.usersList.find((p) => p.user?.Email === email);
    }

    /**
     * Finds a user by username
     * @param username The username to search for
     * @returns The matching profile or undefined
     */
    findByUsername(username: string): ClientSession | undefined {
        return this.usersList.find((p) => p.user?.Username === username);
    }

    /**
     * Gets all users connected since a certain date
     * @param timestamp Reference timestamp
     * @returns Array of matching profiles
     */
    getActiveUsersSince(timestamp: number): ClientSession[] {
        return this.usersList.filter((p) => p.user && p.user.LastLogin > timestamp);
    }

    /**
     * Executes a function for each connected user
     * @param callback Function to execute for each user
     */
    forEach(callback: (profile: ClientSession, userId: number) => void): void {
        this.users.forEach(callback);
    }

    /**
     * Transforms all users with a function
     * @param callback Transformation function
     * @returns Array of transformed results
     */
    map<T>(callback: (profile: ClientSession) => T): T[] {
        return this.usersList.map(callback);
    }

    /**
     * Completely clears the list of connected users
     */
    clear(): void {
        this.users.clear();
        this.usersList.length = 0;
    }

    /**
     * Gets statistics of connected users
     * @returns Object with statistics
     */
    getStats(): {
        totalConnected: number;
        userIds: number[];
        usernames: string[];
    } {
        return {
            totalConnected: this.count(),
            userIds: this.map((p) => p.user?.ID || 0).filter((id) => id > 0),
            usernames: this.map((p) => p.user?.Username || '').filter((name) => name !== '')
        };
    }
}

// Export singleton instance for global usage
export const userManager = new UserManager();

export default UserManager;
